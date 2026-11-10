# Personal Accountant: Projects, cost estimator and sharing (spec)

Status: **P6a, P6b, P6-share, P6c and P6e (partly) built**. P6c: app screens in `Sawa-app` (`app.p9.js`, Projects tab).
P6e: CSV export and a printable report (save as PDF from the browser). Native .xlsx is not built. Not built: the wallet link (P6d).
No Firestore rules are needed: all access goes through the Worker.
Extends `pfm/DESIGN.md`. Everything there still applies: integer minor units, decimal text for rates and quantities,
server-side totals, sealed free text, the audit chain, and the twelve accepted currencies (decision 8).

---

## 1. What it does

A **project** is a workspace (House construction, Event, Small business, Agricultural season, or Custom) with a name, dates,
a target budget and a description. It can be **shared** with other users as editors or viewers.

1. **Estimate (BOQ).** Before launch the owner or an editor lists the resources: category, item, unit, quantity and unit price.
   Approving the estimate freezes it as the **baseline**. Later changes are change orders (new revisions with a reason).
2. **Ledger.** After launch: capital, loans, partner money, grants and sales (inflows), and expenses (outflows, optionally on a BOQ
   line with a quantity). An expense can also be **copied to the personal ledger** (§2, P12).
3. **Variance, health and forecast.** Per line: quantity and price variance and a status. Per project: spend against budget,
   a forecast at completion, margin, cash position and threshold alerts (80 % and 100 % by default).
4. **Charts.** One op returns the series: estimate vs actual by category, monthly totals, and a daily running balance. The app
   draws them (P6c) and the export uses the same data (P6e).
5. **Sharing.** The owner invites people with a link. Roles: owner, editor, viewer (§2, P13).

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| P1 | **Project data is isolated from the personal ledger.** It lives in its own collections, and the personal monthly totals do not include it unless the entry is copied (P12) | A house build should not inflate personal "spending this month" |
| P2 | **Firestore, not PostgreSQL.** "Migrations" are versioned, idempotent steps run by the Worker (`projects-migrations.mjs`), tracked per user in `pfm/{uid}/meta/projects` | The accountant already runs on Firestore and the Worker |
| P3 | **Wallet link is deferred** (`DESIGN.md` decision 13). Entries are typed in by hand until then | There is no server wallet ledger to link to |
| P4 | **Project currency is fixed at creation.** An entry in another accepted currency takes a user-typed rate; the original amount and rate are kept | Same rule as decisions 8 and 11 |
| P5 | **The baseline is immutable.** Only a draft revision accepts edits. Approval makes it the baseline; later changes are change orders with a reason | Variance is only meaningful against a fixed plan |
| P6 | **Lines keep a stable `lineKey` across revisions** | A change order must not orphan earlier spending |
| P7 | **Alerts are keyed** (`budget:<pct>:<estimateId>`, `forecast:<estimateId>`, `line:<lineKey>:<estimateId>`). Each fires once per revision and clears when no longer true | Same once-per-threshold rule as personal budgets |
| P8 | **Cost is expenses only.** A loan repayment is cash out but not cost. The cash position includes it | Otherwise a repayment would look like an overrun |
| P9 | **Quantities** have 3 decimals (BigInt scaled by 1000), stored as text. Line total = round(qty × unit price) | Same as invoices |
| P10 | **The server does all calculation.** The client sends inputs and shows what comes back | Same as invoices |
| P11 | **No tax on estimate lines.** Decided by the owner, 2026-11-09. Not in the schema, and not planned for now | Owner's decision |
| P12 | **Copy an expense to the personal ledger (opt-in per entry).** `copyToPersonal: {categoryId}` books a linked row in the **recorder's own** personal ledger in the same commit. The copy is marked `projectRef` and cannot be edited or deleted from the personal side. Voiding the project entry voids the copy **if the recorder is the one voiding**; a copy in another member's ledger is left alone and the reply says so (`personalCopyKept`). A foreign currency needs `personalFxRate` | Personal budgets see real project spending, without the project's other rows moving into the personal ledger. A member's personal ledger is theirs to control |
| P13 | **Sharing with three roles.** Owner: everything, including members, invites and deletion. Editor: entries, estimates, alerts, edits to the project. Viewer: reads only. Invites are tokens: they grant editor or viewer (never owner), expire after 1–30 days (default 7), and can be used 1–10 times (default 1). A non-member gets `not_found`, so the project's existence is not revealed | Several people manage one project; the owner stays in charge of who is in it |
| P14 | **Shared data is top-level.** Project data lives in `pfmProjects/{pid}`, not under one user. Each user keeps `pfm/{uid}/projectIndex/{pid}` for their list. Sealed text is bound to the project (`proj:{pid}`), so every member can open it through the Worker | Members must reach the same data. Binding to the project lets members open it without holding the owner's key |

---

## 3. Data model (Firestore)

Paths are relative to the document root. 🔒 = sealed (`sealField`, bound to the project as `proj:{pid}`). ⚙ = written by the Worker only.

### 3.1 `pfm/{uid}/meta/projects` ⚙ — schema version
`{ schemaVersion: 1, appliedAt, lastMigration }`

### 3.2 `pfm/{uid}/projectIndex/{pid}` — the user's list
`{ role: "owner" | "editor" | "viewer", createdAt }`. Written with the membership and removed with it.

### 3.3 `pfmProjects/{pid}` — project
```ts
{ ownerUid, name, template: "house_construction" | "event" | "small_business" | "agri_season" | "custom",
  description: 🔒, currency: "SDG" (fixed, P4),
  startDate, endDate, targetBudget: 300000 (minor units, > 0),
  status: "planning" | "active" | "on_hold" | "completed" | "archived",
  baselineEstimateId, alertThresholdsPct: [80, 100], lineTolerancePct: 5,
  rev ⚙, createdAt ⚙, updatedAt ⚙ }
```
Transitions: planning → active · active → on_hold | completed · on_hold → active · any open state → archived.

### 3.4 `pfmProjects/{pid}/members/{uid}`
`{ role, displayName (≤ 40, optional), addedAt, addedBy }`. The owner's row is created with the project.

### 3.5 `pfmProjects/{pid}/estimates/{eid}` — revision
`{ revision, status: "draft" | "baseline" | "superseded", reason, approvedAt, approvedBy, total, lineCount, rev, createdAt, updatedAt }`.
Only one draft and one baseline at a time.

### 3.6 `pfmProjects/{pid}/estimates/{eid}/lines/{lineKey}` — BOQ line
Document ID = `lineKey` (`[A-Za-z0-9_-]`, ≤ 64). `{ category, name: 🔒, unit, estQty: "100", estUnitPrice, estTotal, notes: 🔒, sortOrder }`.
Written once with the revision; read-only after approval. A commit holds at most 500 writes, so a revision has at most 400 lines.

### 3.7 `pfmProjects/{pid}/tx/{txId}` — project ledger
```ts
{ kind: "capital_injection" | "loan_draw" | "partner_contribution" | "grant" | "revenue"   // inflows
        | "expense" | "loan_repayment",                                                     // outflows
  direction ⚙, amount (project currency minor units), originalAmount, originalCurrency, fxRate,
  lineKey | null, category | null, quantity: "110" | null, unit | null,
  description: 🔒, counterparty: 🔒, occurredOn: "2026-11-03",
  status: "posted" | "voided", voidReason: 🔒, voidedAt ⚙,
  createdBy, rev ⚙, createdAt ⚙,
  personalCopy: { uid, txId } | null }          // P12: where the linked personal row is
```
Voiding keeps the row. Totals ignore voided rows.

### 3.8 `pfmProjects/{pid}/alerts/{key}` ⚙
`{ rule, severity, thresholdPct?, lineKey?, estimateId, createdAt, acknowledgedAt }`. Creation uses "must not exist",
so two writers produce one alert.

### 3.9 `pfmInvites/{token}` ⚙
`{ pid, role, maxUses, uses, createdBy, createdAt, expiresAt }`. The token is 24 random characters. Uses are counted with a
precondition, so two people accepting at once cannot both use the last one.

### 3.10 Personal ledger copy (P12)
A copy is an ordinary row in `pfm/{uid}/tx/tp_{txId}` with `projectRef: { pid, txId }`, `source: "manual"`, and the usual
rollup. `pfm.tx.update` and `pfm.tx.delete` refuse it with `linked_project_entry`.

### 3.11 Limits (v1)
2,000 ledger rows read per project (the Worker reads up to 3,000) and 400 lines per revision. Health and charts are
recomputed from the rows on each read. A rollup document is needed above that.

---

## 4. Calculations

All in `projects-core.mjs`. BigInt, rounding half away from zero, basis points for percentages.

**Line total:** `estTotal = round(estQty × estUnitPrice / 1000)`

**Line variance** (AC actual cost, AQ actual quantity, ET estimate total, EQ estimate quantity, EP estimate unit price)

| Field | Formula |
|---|---|
| `totalVariance` | AC − ET |
| `quantityEffect` | round((AQ − EQ) × EP) |
| `priceEffect` | totalVariance − quantityEffect (equals (AP − EP) × AQ; taken as the remainder so the two always sum exactly) |
| `status` | `not_started` if AC = 0 · `on_budget` if AC ≤ ET · `warning` if above ET within tolerance · `over_budget` if AC > ET × (1 + tolerance) |

Worked example: 100 bags estimated at 10.00 (1,000.00). 110 bags actually cost 1,210.00. Quantity effect 100.00, price effect 110.00,
total 210.00. Status: over budget (above the 5 % tolerance).

**Project health:** utilization = spend ÷ target · EAC (forecast at completion) = Σ max(actual, estimate) per line + unbudgeted
spend + spend on lines no longer in the revision · margin = (revenue − spend) ÷ revenue · cash position = all inflows − all
outflows · status red if utilization ≥ 100 % or EAC > target, amber if utilization ≥ the first threshold (80 %), otherwise green.

**Charts** (`chartSeries`): estimate vs actual per BOQ category (an unbudgeted expense counts under its own category) · monthly
actual spend and inflows · daily inflows, outflows and running balance.

**Alerts** (`alertsFor`): one per crossed threshold, one for a forecast over budget, one per line that is `warning` or `over_budget`.

---

## 5. Operations (`pfm.proj.*`)

Same house convention: `POST /api`, `{ op, ...payload }`, Bearer ID token. `worker-3.js` routes every `pfm.*` op to
`handlePfmOp` and needs no change. Each op first brings the schema up to date. Each op checks the caller's role
(`accessOf`): a non-member gets `not_found`; a role that is too low gets `forbidden`. Creates use the client's `idemKey` as
the document ID, so a retry returns the first result. Every write has a precondition on the project row.

| op | Payload → result | Role |
|---|---|---|
| `pfm.proj.create` | `idemKey`, project fields, `displayName?` → `{project}` | any (needs `pfm.init`) |
| `pfm.proj.list` | → `{items}`: each project with `role` and a health summary | any |
| `pfm.proj.get` | `{pid}` → `{project, role, members, estimates, estimateId, health}` | viewer |
| `pfm.proj.update` | `{pid, rev, …changed}` → `{project}` | editor |
| `pfm.proj.status` | `{pid, rev, to}` → `{project}` | editor |
| `pfm.proj.delete` | `{pid, confirm: pid}` → `{deleted}` | owner |
| `pfm.proj.estimate.create` | `idemKey`, `reason?`, `fromBaseline?` → `{estimate}` | editor |
| `pfm.proj.estimate.lines` | `{pid, eid, rev, lines}` → `{estimate, totals}` | editor |
| `pfm.proj.estimate.approve` | `{pid, eid, rev}` → `{estimate}` | editor |
| `pfm.proj.tx.add` | `idemKey`, entry fields, `copyToPersonal?: {categoryId}`, `personalFxRate?` → `{tx, personalCopyId}` | editor |
| `pfm.proj.tx.void` | `{pid, txId, reason}` → `{tx, personalCopyKept}` | editor |
| `pfm.proj.tx.list` | `{pid, kind?, lineKey?}` → `{items, truncated}` | viewer |
| `pfm.proj.health` | `{pid, estimateId?}` → `{estimateId, health}` | viewer |
| `pfm.proj.variance` | `{pid, estimateId?}` → `{estimateId, currency, lines}` (with names) | viewer |
| `pfm.proj.charts` | `{pid, estimateId?}` → `{budget, byCategory, byMonth, daily}` | viewer |
| `pfm.proj.alerts.list` | `{pid, unacknowledged?}` → `{items}` | viewer |
| `pfm.proj.alerts.ack` | `{pid, key}` → `{alert}` | editor |
| `pfm.proj.members.list` | `{pid}` → `{items}` | viewer |
| `pfm.proj.members.role` | `{pid, uid, role: editor\|viewer}` → `{member}` | owner |
| `pfm.proj.members.remove` | `{pid, uid?}` (no `uid` = leave) → `{removed}` | owner, or the member themselves |
| `pfm.proj.invite.create` | `{pid, role, maxUses?, days?}` → `{invite: {token, expiresAt}}` | owner |
| `pfm.proj.invite.accept` | `{token, displayName?}` → `{project, role}` | any signed-in user |
| `pfm.export` *(P6e)* | | not built |

**Account deletion (`purgePfm`):** for each project in the user's index — if they own it, the project is deleted for everyone
(its estimates, lines, ledger, alerts, members and everyone's index entries); if they are a member, only their membership and
index entry are removed. The personal ledger and `pfm/{uid}/meta` are removed as before.

---

## 6. Security and audit

- **No Firestore rules added.** Every client read and write is denied; the app uses `pfm.proj.*`.
- **Roles on every op** (`accessOf`). Non-members see `not_found`. The owner's role is fixed; an invite never grants it.
- **Sealed fields:** names, descriptions, line notes, entry descriptions, counterparties and void reasons. Bound to the
  project, not to one user. Amounts, dates, quantities and statuses stay clear, because the server aggregates them.
- **Invites:** 24-character random tokens, expiry (1–30 days), a use limit (1–10), and atomic use counting. The token itself is
  never written to the audit log.
- **Audit:** `project.create`, `project.update`, `project.status`, `project.delete`, `estimate.create`, `estimate.lines`,
  `estimate.approve`, `ptx.add`, `ptx.void`, `alert.ack`, `member.join`, `member.role`, `member.remove`, `member.leave`,
  `invite.create`. Each entry is in the chain of the user who acted. A personal copy is audited in the recorder's chain.
- **Rate limits:** the existing `pfm.*` limits apply. No new public endpoint.

---

## 7. Code

| File | What it is | Status |
|---|---|---|
| `projects-core.mjs` | Validators, line totals, variance, project health, alerts, lifecycle guards, roles, `chartSeries`, `paths` | Built, tested |
| `projects-core.test.mjs` | Worked examples, rounding, statuses, alerts, lifecycle, chart series | `node pfm/projects-core.test.mjs` · 16 |
| `projects-migrations.mjs` | `MIGRATIONS` (v1 `projects_init`), `migrateProjects` | Built, tested |
| `projects-migrations.test.mjs` | Fresh user, re-run, `schema_ahead`, failed step retried, ordering | `node pfm/projects-migrations.test.mjs` · 7 |
| `pfm-worker.mjs` (Projects section) | The ops in §5, roles, invites, copy to personal, charts, deletion | Built |
| `projects-worker.test.mjs` | Create, update, status, estimates and change orders, ledger rules, alerts, concurrency; invites (use limit, expiry, not-a-member), roles, leave and remove, delete, copy to personal (incl. another member's copy), charts, account deletion | `node pfm/projects-worker.test.mjs` · 18 |

---

## 8. Charts

`pfm.proj.charts` returns series only. The app draws the bars and the balance line (P6c). The export draws the same series
in the PDF and as native workbook data (P6e). Charts show the same numbers as the health output, to the minor unit.

---

## 9. Delivery

| Phase | Scope | Exit check |
|---|---|---|
| P6a ✅ | Data model, calculation module, migrations, tests | Worked examples match; effects sum to the total; a second migration run writes nothing |
| P6b ✅ | Worker ops (single user) | A duplicate `idemKey` writes once; concurrent approvals leave one baseline; the audit chain stays whole |
| P6-share ✅ | Roles, invites, members, copy to personal, charts data, deletion for members | An invite is used once per use slot; a viewer cannot write; a member's personal copy is not touched by the owner |
| P6c ✅ | App: project list, create, join by invite, estimate editor (draft, approve), ledger with copy to personal, overview with charts and alerts, people and invites | `pfm/projects-ui-check.mjs` passes (create → draft → approve → entry → invite) in Chromium, Arabic light; screenshots checked |
| P6d | Wallet link (blocked on `DESIGN.md` decision 13) | Tagging a wallet payment writes one entry; reversing it voids the entry |
| P6e ◐ | Export from the same data: CSV (opens in Excel and Sheets) and a printable report (print to PDF). Native .xlsx not built | Formula cells in CSV are defused; the report escapes all user text; the viewer can export, a stranger cannot |

---

## 10. Open questions

1. **Excel charts.** `exceljs` cannot write native charts. Options: a Python step with openpyxl, or a picture drawn from the same
   series as the PDF. Choose when P6e starts.
2. **Owner transfer.** The owner cannot hand a project over yet. Only deletion is possible. Add if needed.
3. **Display names.** Members choose their own display name when they join. Changing it later is not built.

---

## 11. Export (P6e, as built)

- `pfm.proj.export` → `{filename, csv, rows}`. A UTF-8 CSV with a byte-order mark, so Arabic opens correctly in Excel. Text cells
  starting with `=`, `+`, `-`, `@` are defused. Amounts are numbers.
- `pfm.proj.report` → `{filename, html}`. A self-contained HTML page: summary cards, category bars, estimate lines, entries.
  All user text is escaped. The app saves it as a file; open it in the browser and print, or save as PDF.
- Excel (.xlsx) is not built. Open the CSV in Excel or Google Sheets.

---

## 12. Dated prices, price history and attachments (C284, schema v2)
- **Line fields:** `priceDate` (date on the quote; default the user's today; not before 2000, not after today), `supplier` 🔒, `pricedAt` ⚙ (server time the price was entered), `priceLog` ⚙ `[{ unitPrice, priceDate, pricedAt, by, revision, supplier🔒 }]`. Saving a draft with the same price, date and supplier keeps the stamp; any change appends an entry (≤ 60, the first is always kept). A revision started from the baseline copies the log, so history follows the `lineKey`. Lines saved before v2 read as priced when their revision was created.
- **`pfmProjects/{pid}/files/{fid}`** `{ target: {type: project|estimate|line|tx, estimateId?, lineKey?, txId?}, kind: photo|quote|supplier_invoice|receipt|other, name🔒, note🔒, type, size, sha256, parts, docDate, quotedUnitPrice, uploadedAt ⚙, uploadedBy ⚙, removedAt ⚙, removedBy ⚙, removeReason🔒 }`; bytes in `files/{fid}/parts/{000…}` (sealed base64, 384 KB raw each). JPEG/PNG/WebP/PDF by their bytes, ≤ 4 MB, ≤ 20 per target, ≤ 300 per project. Never edited; removal keeps the record and deletes the parts. Editors add/remove, viewers list/open.
- **`pfm.proj.prices`** `{ pid, lineKey? }` → per line: `estimates` (all revisions, de-duplicated, by `pricedAt`), `quotes` (from quote files with a price), `actual` (posted expenses on the line with a quantity: amount ÷ quantity), `changeBp` (latest vs first estimate), `actualVsEstimateBp` (paid vs the estimate whose `priceDate` was in force on each purchase day).
