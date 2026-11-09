# Personal Accountant: Projects & cost estimator (spec)

Status: **P6a scaffold built** (data model, calculation module, migrations, tests). Worker ops, UI, rules and exports are not built yet.
Extends `pfm/DESIGN.md`. Everything there still applies: integer minor units, decimal text for rates and quantities,
server-side totals, encrypted free text, the audit chain, and the twelve accepted currencies (decision 8).

---

## 1. What it does

A **project** is an isolated workspace (House construction, Event, Small business, Agricultural season, or Custom) with a name,
dates, a target budget, and a description.

1. **Estimate (BOQ).** Before launch the user lists the resources: category, item, unit, quantity and unit price. The total is
   computed. Approving the estimate freezes it as the **baseline**.
2. **Ledger.** After launch the user records money in and out: capital, loans, partner money, grants, sales (inflows), and
   expenses (outflows, optionally tied to a BOQ line with a quantity).
3. **Variance and health.** Per line: quantity variance, price variance, total variance and a status. Per project: spend against
   budget, a forecast at completion, margin and cash position, and threshold alerts (80 % and 100 % by default).
4. **Export.** An executive PDF and an Excel workbook (phase P6e, not built).

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| P1 | **Project money lives in its own subtree**, `pfm/{uid}/projects/{pid}/…`. It is **not** in `pfm/{uid}/tx`, and it does not touch the personal months rollups | "Isolated" is the requirement. A house build should not inflate personal "spending this month". Copying a project expense into the personal ledger is a later, opt-in choice |
| P2 | **Firestore, not PostgreSQL.** "Migrations" here means versioned, idempotent steps run by the Worker (`projects-migrations.mjs`), tracked per user in `pfm/{uid}/meta/projects` | The whole Personal Accountant runs on Firestore and the Worker. A second database would split the audit chain and the encryption |
| P3 | **Wallet link is deferred.** "Tag a Sawa Wallet payment to a project" depends on the wallet ledger, which is off (`DESIGN.md` decision 13, `PFM_WALLET`). Until then, entries are typed in by hand | The spec asked for it, but the wallet has no server ledger to link to yet. The `source` field and a unique `walletTxId` slot are reserved so it can be added later without a migration |
| P4 | **Project currency is fixed at creation.** An entry in another accepted currency needs a user-typed rate (`fxRate`), exactly like personal entries. The original amount and rate are kept | Same rule as decisions 8 and 11. Changing the currency would rewrite history |
| P5 | **Baseline is immutable.** Only a `draft` revision accepts edits. Approving makes it the `baseline`. Later changes are new revisions (change orders) with a reason | Variance is only meaningful against a fixed plan |
| P6 | **Lines keep a stable `lineKey` across revisions.** Expenses point at the `lineKey`, not at a revision's document ID | A change order must not orphan last month's spending |
| P7 | **Alerts are keyed.** `budget:<pct>:<estimateId>`, `forecast:<estimateId>`, `line:<lineKey>:<estimateId>`. Each fires once per revision; a stored alert clears when it no longer applies, which re-arms it | Same once-per-threshold rule as personal budgets (P2 in `DESIGN.md`) |
| P8 | **Cost is expenses only.** `loan_repayment` is cash out but is principal, not project cost. The cash position includes it | Otherwise a loan repayment would look like an overrun |
| P9 | **Quantities**: 3 decimals as BigInt scaled by 1000 (`toQty`), stored as text (`"2.5"`). Line total = round(qty × unit price) | Same as invoices |
| P10 | **Calculation is on the server only.** The client sends inputs and shows the returned health. Totals are never trusted from the client | Same as invoices (`DESIGN.md` §1, decision 1) |

---

## 3. Data model (Firestore)

Paths are relative to the document root. 🔒 = sealed with the user's key (`sealField`, AAD = uid, §6 of `DESIGN.md`).
⚙ = written only by the Worker.

### 3.1 `pfm/{uid}/meta/projects` ⚙ — schema version
```ts
{ schemaVersion: 1, appliedAt: "2026-11-09T…Z", lastMigration: "projects_init" }
```

### 3.2 `pfm/{uid}/projects/{pid}` — project
```ts
{ name: "House", nameSealed?: …,                 // name is clear text; description and counterparty fields are 🔒
  template: "house_construction" | "event" | "small_business" | "agri_season" | "custom",
  description: 🔒 string,
  currency: "SDG",                                // fixed once any money is recorded (P4)
  startDate: "2026-11-01" | null, endDate: "2026-12-31" | null,
  targetBudget: 300000,                           // minor units, > 0
  status: "planning" | "active" | "on_hold" | "completed" | "archived",
  baselineEstimateId: "e_1" | null ⚙,
  alertThresholdsPct: [80, 100],                  // ascending, 1–200
  lineTolerancePct: 5,                            // 0–100: overrun allowed before a line turns over_budget
  createdAt ⚙, updatedAt ⚙, rev ⚙ }
```
Transitions (`assertProjectTransition`): planning → active · active → on_hold | completed · on_hold → active · any open state → archived.

### 3.3 `pfm/{uid}/projects/{pid}/estimates/{eid}` — revision
```ts
{ revision: 1, status: "draft" | "baseline" | "superseded" ⚙, reason: "Initial estimate" | "Change order #2",
  approvedAt: ⚙ | null, createdAt ⚙ }
```
Only one `baseline` per project. Approving a new revision makes the old baseline `superseded` in the same commit.

### 3.4 `…/estimates/{eid}/lines/{lineKey}` — BOQ line
The document ID is the `lineKey` (`[A-Za-z0-9_-]`, ≤ 64 characters), so a line is unique within its revision.
```ts
{ category: "raw_materials" | "labor" | "equipment_rental" | "permits" | "other",
  name: 🔒 string (≤ 160), unit: "bag" (≤ 16),
  estQty: "100",                                  // decimal text, > 0, ≤ 3 places
  estUnitPrice: 1000,                             // minor units, ≥ 0
  estTotal: 100000 ⚙,                            // round(estQty × estUnitPrice)
  sortOrder: 0, notes: 🔒 string }
```
A revision's lines are written once, in the same commit as the revision (or while it is `draft`). After approval they are read-only.

### 3.5 `pfm/{uid}/projects/{pid}/tx/{txId}` — project ledger
```ts
{ kind: "capital_injection" | "loan_draw" | "partner_contribution" | "grant" | "revenue"    // inflows
        | "expense" | "loan_repayment",                                                      // outflows
  direction: "inflow" | "outflow" ⚙,              // derived from kind
  amount: 125000,                                 // minor units of the project currency, > 0
  originalAmount: 10000, originalCurrency: "USD", fxRate: "600" | null,   // when the entry is in another currency
  lineKey: "cement" | null,                       // expense on a BOQ line
  category: "other" | null,                       // expense not on a line (unbudgeted)
  quantity: "110" | null, unit: "bag" | null,     // expense only, optional
  description: 🔒 string (≤ 200), counterparty: 🔒 string (≤ 120),
  occurredOn: "2026-11-03",
  status: "posted" | "voided",
  voidReason: 🔒 string | null, voidedAt ⚙,
  walletTxId: null,                               // reserved for P3 (deferred)
  createdAt ⚙, rev ⚙ }
```
Voiding keeps the row. Totals ignore voided rows. Nothing is deleted, so the audit chain stays whole.

### 3.6 `pfm/{uid}/projects/{pid}/alerts/{dedupeKey}` ⚙
```ts
{ rule: "budget_threshold" | "forecast_overrun" | "line_overrun", severity: "warning" | "critical",
  thresholdPct?: 80, lineKey?: "cement", estimateId: "e_1",
  createdAt ⚙, acknowledgedAt: null }
```
Creation uses a "document must not exist" precondition. Two concurrent writers therefore produce one alert.

### 3.7 Indexes
- `tx`: `(occurredOn desc)` for the ledger list, `(lineKey, status)` for line drill-down. Both are small enough to scan per project in v1.
- `alerts`: `(acknowledgedAt, createdAt desc)`.

### 3.8 Size limits (v1)
Up to **2,000 ledger rows per project** and **500 lines per revision**. Health is recomputed from the rows on each read. Above that
limit a rollup document (`pfm/{uid}/projects/{pid}/rollup` ⚙, updated with increments like `months/`) is needed. Not built yet.

---

## 4. Calculations

All in `projects-core.mjs`. BigInt throughout, rounding half away from zero, basis points for percentages.

**Line total**
`estTotal = round(estQty × estUnitPrice / 1000)` (quantities carry a 1000 scale)

**Line variance** (actual cost `AC`, actual quantity `AQ`, estimate `ET`, `EQ`, `EP`)

| Field | Formula |
|---|---|
| `totalVariance` | AC − ET |
| `quantityEffect` | round((AQ − EQ) × EP) |
| `priceEffect` | totalVariance − quantityEffect (equals (AP − EP) × AQ, taken as the remainder so the two always sum exactly) |
| `actualUnitPrice` | round(AC ÷ AQ), null when AQ = 0 |
| `qtyVariancePct` | (AQ − EQ) ÷ EQ × 100 |
| `status` | `not_started` if AC = 0 · `on_budget` if AC ≤ ET · `warning` if above ET within tolerance · `over_budget` if AC > ET × (1 + tolerance) |

Worked example: 100 bags estimated at 10.00 (1,000.00 total). 110 bags actually cost 1,210.00.
Quantity effect = 10 × 10.00 = **100.00**. Price effect = 1.00 × 110 = **110.00**. Total = **210.00** = 1,210.00 − 1,000.00. Status: over budget (above the 5 % tolerance).

**Project health**

| Field | Formula |
|---|---|
| `actualSpend` | Σ expense (lines and unbudgeted) |
| `utilization` | actualSpend ÷ targetBudget (basis points) |
| `forecastAtCompletion` (EAC) | Σ over lines of max(actual cost, estimate) + unbudgeted spend + spend on lines no longer in the revision |
| `forecastVsBudget` | EAC − target. Positive means the project is forecast to overrun |
| `budgetGap` | target − Σ estimate. Shows whether the plan fits the budget before any spending |
| `net` / `margin` | revenue − actualSpend · net ÷ revenue (null without revenue) |
| `cashPosition` | all inflows − all outflows (includes loan repayments) |
| `status` | **red** if utilization ≥ 100 % or EAC > target · **amber** if utilization ≥ the first threshold (80 %) · **green** otherwise |

EAC counts untouched estimates in full. A project can therefore be forecast over budget while it is still well under budget
in cash. That is the point of the forecast.

**Alerts** (`alertsFor`): one per crossed threshold, one for a forecast overrun, one per line that is `warning` or `over_budget`.
Critical at 100 %, forecast overrun, and `over_budget` lines. Stored keys from the same revision that no longer apply are returned
in `clear`.

---

## 5. Operations (planned, not built)

Same house convention as `DESIGN.md` §3: `POST /api`, `{ op, ...payload }`, `idemKey` on every mutation.

| op | Payload → result | Rule |
|---|---|---|
| `pfm.project.create` | `validateProjectInput` fields → `{project}` | Audit `project.create` |
| `pfm.project.update` | `{pid, rev, …changed}` → `{project}` | Currency and template are refused after the first entry; the server refuses `rev` mismatches (`409 stale`) |
| `pfm.project.status` | `{pid, to}` → `{project}` | `assertProjectTransition` |
| `pfm.estimate.create` | `{pid, fromBaseline?: true}` → `{estimate}` | Copies the baseline's lines under the same `lineKey`s when `fromBaseline`; `reason` required for revision > 1 |
| `pfm.estimate.lines` | `{pid, eid, rev, lines: […]}` → `{estimate, total, byCategory}` | Draft only (`baseline_locked`); `validateBoqLine` for each line |
| `pfm.estimate.approve` | `{pid, eid}` → `{estimate, project}` | `assertCanApprove`; supersedes the old baseline; sets `baselineEstimateId`; project → `active`; runs `alertsFor` once |
| `pfm.ptx.add` | `validateProjectTx` fields → `{tx, health}` | Writes the row, the audit entry and the alert documents in one commit |
| `pfm.ptx.void` | `{pid, txId, reason}` → `{tx, health}` | Status change only, never a delete |
| `pfm.ptx.list` | `{pid, from?, to?, kind?, lineKey?, cursor?}` → `{items, cursor}` | 50 per page, decrypts 🔒 fields for the owner |
| `pfm.health` | `{pid, eid?}` → `projectHealth` output | `eid` defaults to the baseline |
| `pfm.variance` | `{pid, eid?}` → `lines[]` | Per-line decomposition |
| `pfm.alerts.list` / `pfm.alerts.ack` | `{pid, unacknowledged?}` / `{pid, key}` | |
| `pfm.export` *(P6e)* | `{pid, format: "pdf"\|"xlsx"}` | Renders from the same health model; PDF through the existing invoice HTML pipeline |

The Worker wraps each mutation in a precondition commit. Idempotency is by `idemKey`, the same as the personal ledger.

---

## 6. Security and audit

- **Rules:** none added. Like `pfm/`, every client read and write is denied and the app goes through `pfm.*` ops.
- **Sealed fields:** project description, line notes and names, entry descriptions, counterparties and void reasons. Amounts, dates, quantities and statuses stay clear, because the server aggregates them.
- **Audit actions** (added to the `DESIGN.md` §2.10 list): `project.create`, `project.update`, `project.status`, `estimate.create`, `estimate.lines`, `estimate.approve`, `ptx.add`, `ptx.void`.
- **Account deletion:** the existing purge job removes `pfm/{uid}`, which covers the new subtree. Check that the job recurses into subcollections before shipping (it must, for `tx/`).
- **Rate limits:** the existing `rl*` limits for `pfm.*` apply. No new public endpoint.

---

## 7. Code in this folder

| File | What it is | Status |
|---|---|---|
| `projects-core.mjs` | Validators (`validateProjectInput`, `validateBoqLine`, `validateProjectTx`), `lineTotal`, `estimateTotals`, `lineVariance`, `ledgerTotals`, `projectHealth`, `alertsFor`, lifecycle guards, `paths` | Built, tested |
| `projects-core.test.mjs` | Worked examples, rounding invariants, statuses, alert once/re-arm, lifecycle | `node pfm/projects-core.test.mjs` · 15 passed |
| `projects-migrations.mjs` | `MIGRATIONS` (v1 `projects_init`), `migrateProjects(db, uid)`, ordering check at import | Built, tested |
| `projects-migrations.test.mjs` | Fresh user, idempotent re-run, `schema_ahead`, failed step retried, ordering | `node pfm/projects-migrations.test.mjs` · 7 passed |

Not built: Worker routes (`pfm-worker.mjs`), the Firestore adapter for the migration runner, app screens (`app.p9.js`), export.

---

## 8. UI flow (for later, summary)

1. **Projects list:** cards with status and a budget bar (80 % and 100 % ticks).
2. **New project:** basics (name, template, dates, currency) → target budget → estimator.
3. **Estimator:** lines grouped by category, quantity × price, sticky totals, *Approve baseline & launch*. After launch the button becomes *Propose change order*.
4. **Dashboard:** budget gauge, alerts, estimate vs. actual by category, funding cards, margin pill (green / amber / red).
5. **Variance:** per-line chips (quantity and cost), tap to drill into the entries.
6. **Ledger:** Income / Expense / Funding, add-entry sheet with optional line and quantity, void with a reason.
7. **Export:** format, range, include BOQ and ledger, then download or share.

Colours follow the app's `colors` tokens, not fixed hex values, as in C270. Status is never colour alone.

---

## 9. Delivery

| Phase | Scope | Exit check |
|---|---|---|
| **P6a** ✅ (this change) | Data model, calculation module, migrations, tests | Worked examples match the spec; rounding never breaks `quantityEffect + priceEffect = totalVariance`; a second migration run writes nothing |
| P6b | Worker ops §5 (create, lines, approve, entries, void, health, alerts); Firestore adapter for the migration runner; purge job recursion | Concurrent approvals produce one baseline; a duplicate `idemKey` writes once; a voided entry leaves totals unchanged |
| P6c | App: projects list, wizard, estimator, dashboard, ledger, variance | Phone-width layouts in both languages; `ui-check.mjs` extended with a project run-through |
| P6d | Wallet link (**blocked** on `DESIGN.md` decision 13) | Tagging a wallet payment writes one entry; reversing the payment voids it |
| P6e | PDF and Excel export from the same health model | A worksheet's totals match the API response to the minor unit |

---

## 10. Open questions

1. **Tax on BOQ lines.** Not modelled. If needed, add a `taxRate` (ppm, typed) to lines and reuse `computeInvoice`'s per-line rule.
2. **Personal copy.** Should a project expense optionally also post to the personal ledger (P1)? Default off.
3. **Partners.** Single owner for now. Shared projects need `pfm/{uid}/projects/{pid}/members` and role rules, and they change the audit model.
4. **Excel charts.** `exceljs` can't write native charts. Options: a Python step with openpyxl, or an embedded PNG rendered from the same SVG as the PDF. Choose when P6e starts.
