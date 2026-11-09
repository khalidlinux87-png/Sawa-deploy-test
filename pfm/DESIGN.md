# Sawa Wallet: Personal Accountant & Invoicing (PFM) design

Status: rev 9 · **P1 (C263), P2 (C264), P3 (C266) and P4 (C267) implemented** · Date: 2026-11-06 · Code: `pfm/` (Worker ops wired into `worker-3.js`; UI in `Sawa-app/app.p9.js`)

This design follows how Sawa is already built:

| Layer | What already exists | What PFM adds |
|---|---|---|
| Client | PWA (`Sawa-app`, React, `app.p1…p9.js`), with Android and iOS shells | An "Accountant" tab with ledger, dashboard, budgets and invoices, plus a public `/pay/{token}` page |
| API | Cloudflare Worker `worker-3.js`: `POST /api {op, …}`, Firebase ID token, `fsCommit` | `pfm.*` and `inv.*` ops, `GET /pfm/file` (signed PDF download), and a cron step |
| Data | Firestore (REST, service account `SA_JSON`). Client rules deny writes to server-owned data | New collections, below. **Every read and write goes through the Worker**: notes and names are encrypted, so the client could not use them directly, and with no client rules for `pfm/` and `audit/` Firestore denies the app all direct access |
| Files | — | R2 bucket `sawa-pfm-files` (PDFs) and Cloudflare Browser Rendering (HTML to PDF) |
| Push | FCM / APNs (`fcmSend`) | Budget alerts, invoice paid, invoice overdue, bank-transfer claims |
| Payments | Wallet only (client mock) | **Now:** the issuer's own bank and mobile-money accounts printed on the invoice, paid by transfer or cash and recorded in the app. **Later, designed and switched off:** wallet payment (decision 13) and card checkout (decision 10) |

> **Scope now (decision 13).** The Sawa Wallet stays as it is today (client-side, `app.p8.js`), and **PFM does not depend on it**.
> The first release is a standalone accountant: manual ledger, budgets, invoices, and payments by transfer or cash.
> Everything that needs a real server-side balance is fully designed below but marked ⏸ and switched off (`PFM_WALLET=0`):
> the wallet ledger (§2.6), auto-sync of wallet activity (§5.1), and paying an invoice from a wallet balance (§5.2).
> Turning it on later adds those features without changing PFM's data model.

---

## 0. Product decisions (2026-11-05, updated 2026-11-06)

| # | Decision | Where it lands |
|---|---|---|
| 1 | **Tax registration is a per-user setting** (see also decision 9). When it is off, the editor hides every tax field and the server refuses tax (`tax_not_registered`) | §2.1 `taxRegistered`, `applyTaxPolicy()`, §4.3 |
| 2 | **Invoice numbers reset every year:** `INV-2026-0001`, `INV-2026-0002`, … then `INV-2027-0001`. The year is the issue date's year in the issuer's time zone | §2.1 `invoiceSeq`, §5.6, `invoiceNumber()` |
| 3 | **Partial payments are allowed by default.** The issuer can turn them off per invoice (`allowPartial: false`) | §2.7, `applyPayment()` |
| 4 | **Clients without a Sawa account can pay** on `/pay/{token}` with no sign-up. **Today:** bank or mobile-money transfer, reported and confirmed (§5.5). **Later:** card, once decision 10 is reversed | §5.4, §5.5 |
| 5 | **The issuer can add a logo**, printed on the PDF, the pay page and the invoice card in chat | §2.1 `logoKey`, §5.7, `sniffLogo()` |
| 6 | **The issuer can save accounts for receiving money:** bank accounts and mobile money (and Sawa Wallet, once decision 13 is reversed) (any provider, e.g. M-Pesa, STC Pay, Bankak). Each invoice prints the ones the issuer picks. A payer who transfers can report it, and the issuer confirms it | §2.9, §5.5, `validatePayoutAccount()` |
| 7 | **Not tied to any country.** No defaults for currency, time zone, tax, banks or payment providers. Onboarding suggests the currency and time zone from the device, and the user confirms them | §2.1, §4.1 |
| 8 | **Twelve currencies, mixed freely** (list set 2026-11-08). Accepted: SDG, USD, CNY, QAR, SAR, AED, GBP, CAD, OMR, EGP, KWD, JPY — Sudanese pound, US dollar, Chinese yuan, Qatari riyal, Saudi riyal, UAE dirham, pound sterling, Canadian dollar, Omani riyal, Egyptian pound, Kuwaiti dinar, Japanese yen. Anything else is refused with `bad_currency`. Decimal places come from CLDR: JPY 0, OMR and KWD 3, the rest 2. Entries, invoices, budgets, wallet balances and receiving accounts each carry their own currency from this list. Reports convert to the user's chosen base currency at a rate stored on each entry. The list lives in `ALLOWED_CURRENCIES` (`pfm-core.mjs`) and `CURS` (`app.p9.js`); adding one means both, and a currency must never be removed while money is stored in it | §5.8, `currencyExp()`, `convert()` |
| 9 | **Tax is set by hand.** The issuer types the rate (e.g. `15`, `7.5`, `8.875`) and names the tax (VAT, GST, TVA, sales tax…). Sawa never looks up or assumes a rate. Frequent rates can be saved | §2.1 `taxRates`, `applyTaxPolicy()`, §4.3 |
| 10 | **No card provider for now.** Card checkout (§5.4) stays designed but behind the `PFM_CARD` switch, off. The pay page offers transfers only (wallet too, once decision 13 is reversed) | `payOptions()`, §5.4 |
| 11 | **FX source and margin: decided later.** Until then there is no automatic rate feed and no paying from another currency's balance (`PFM_FX_QUOTES` off). Foreign-currency entries take the rate the user types, pre-filled with their own last rate for that pair | §2.9b, §5.8 |
| 12 | **Card money goes straight to the issuer's bank account**, when cards are switched on. Sawa never holds it: the provider settles to the issuer's bank, and the fee is recorded as an expense | §5.4 |
| 13 | **No server-side wallet balance for now.** PFM ships without wallet auto-sync or wallet payment. Clients pay by bank or mobile-money transfer (reported, then confirmed) or cash, and the issuer records it. The wallet designs stay, behind `PFM_WALLET`, off | §2.6, §5.1, §5.2, `payOptions()` |

---

## 1. Architecture

```
 ┌───────────── PWA (Sawa-app) ─────────────┐        ┌──────────── Cloudflare Worker ────────────┐
 │ Accountant tab                           │  op    │ pfm.tx.*  pfm.cat.*  pfm.budget.*         │
 │  ├ Dashboard (reads pfm/{uid}/months)    ├───────►│ inv.*  inv.pay  inv.pdf                   │
 │  ├ Ledger    (reads pfm/{uid}/tx)        │        │   │ verify ID token · rate limit          │
 │  ├ Budgets                               │        │   │ pfm-core.mjs (money math, rules)      │
 │  └ Invoices / Invoice editor             │        │   ▼                                       │
 │ /pay/{token} (public, no login to view)  │        │ fsCommit(writes + preconditions          │
 └───────────────▲──────────────────────────┘        │          + increments + audit entry)     │
                 │ onSnapshot (read-only)            │   │                                       │
 ┌───────────────┴──────── Firestore ───────────────┴───▼──┐   ┌── R2 sawa-pfm-files ──┐        │
 │ pfm/{uid}/…  invoices/{id}  payLinks/{token}             │   │ invoices/…/{hash}.pdf │◄─ Browser│
 │ wallets/{uid}/…  audit/{uid}/log/{seq}                   │   └───────────────────────┘  Rendering
 └──────────────────────────────────────────────────────────┘   cron */5: overdue sweep, alerts, audit anchor
```

Decisions:

1. **The Worker is the only writer.** Totals, balances, status changes and audit entries are computed on the server in one atomic
   `commit`. The client never sends a total: it sends inputs and gets back the computed totals.
2. **Integer minor units everywhere**, with a `currency` on every money-bearing document. Minor units follow the currency:
   `123450` is 1,234.50 USD, 123,450 JPY, or 123.450 KWD. Rates the user types (tax, % discounts) and FX rates are **decimal strings**
   (`"8.875"`, `"3.7500"`). Quantities are decimal strings with up to 3 places. No floats.
3. **Precomputed monthly rollups** (`pfm/{uid}/months/{YYYY-MM}`) are updated in the same commit as each transaction with
   Firestore `increment` transforms. The dashboard and budget meters read one document instead of scanning the ledger.
4. **Idempotent by design.** A wallet sync (later) writes `tx/w_{walletTxId}`, and a payment writes `payments/{idemKey}` with
   `exists:false`, so a retry or a duplicate event cannot double-count. This matches `gfetch`, which already refuses to retry
   commits that carry preconditions or increments.
5. **Twelve currencies (decision 8), one reporting currency.** Each user picks a `baseCurrency` at onboarding (suggested from the device locale, never
   assumed). A transaction keeps `amount` and `currency` as they happened, plus `baseAmount` at the `fxRate` recorded **when it was written**
   (typed by the user for now; decision 11).
   Rollups and budgets use `baseAmount`, so past months never shift when rates move. Details in §5.8.

---

## 2. Data model (Firestore)

Paths are relative to `DOC_ROOT`. 🔒 = encrypted field (AES-256-GCM, one key per user, see §6). ⚙ = written only by the server.

### 2.1 `pfm/{uid}` — settings
```ts
{ baseCurrency: "GBP", tz: "Europe/London", locale: "en",           // chosen at onboarding: suggested from the device, confirmed by the user
  country?: "DE",                                                     // optional, informational only: nothing is derived from it
  monthStartDay: 1,                                                   // a budget month can start on payday
  taxRegistered: false,                                               // decision 1: off ⇒ no tax fields, server refuses tax
  taxLabel: "VAT",                                                    // decision 9: the issuer's own name for the tax (≤ 24 chars)
  taxRates: [{ id: "std", label: "Standard", rate: "19" },            // the issuer's saved rates, typed by hand; may be empty
             { id: "red", label: "Reduced",  rate: "7" }],
  defaultTaxRateId: null,                                             // pre-selected on new lines; null = no tax until the user picks one
  defaultInvoiceCurrency: "GBP",                                      // pre-selected; each invoice can use any accepted currency
  invoicePrefix: "INV",                                               // A–Z/0–9, up to 8 characters
  invoiceSeq: { "2026": 42 } ⚙,                                       // decision 2: one counter per year, a new year starts at 1
  defaultDueDays: 14, defaultAllowPartial: true,                      // decision 3
  defaultPayoutAccountIds: ["pa_wallet", "pa_3f…"],                   // decision 6: pre-selected on new invoices
  issuerProfile: { name, contact, address 🔒, taxId 🔒,
                   logoKey: "logos/{uid}/{sha256}.png" ⚙ },          // decision 5; pre-fills new invoices
  autoSync: { enabled: false, since: null },                          // ⏸ decision 13: stays off until the wallet ledger exists
  keyVersion: 1 ⚙, createdAt ⚙ }
```

### 2.2 `pfm/{uid}/categories/{catId}`
```ts
{ name: "Utilities", nameAr: "خدمات", kind: "expense" | "income" | "both",
  icon: "bolt", color: "#0f766e", parentId: null,                     // one level of subcategories
  system: false,                                                      // seeded defaults: system=true, can be renamed or hidden, not deleted
  archived: false, order: 3, createdAt ⚙ }
```
Seeded defaults: `c_salary`, `c_freelance`, `c_invoices`, `c_transfers_in`, `c_refunds`, `c_food`, `c_utilities`,
`c_invoices_paid`, `c_rent`, `c_transport`, `c_maintenance`, `c_telecom`, `c_health`, `c_education`, `c_family`, `c_fees`, `c_internal`, `c_uncategorized`.
Deleting a category in use archives it and moves its future rules to `c_uncategorized`. Old rows keep their `categoryId`.

### 2.3 `pfm/{uid}/tx/{txId}` — ledger
```ts
{ kind: "income" | "expense" | "transfer",   // a transfer between the user's own accounts is neither income nor spending
  amount: 2500,                               // > 0, in minor units; the sign comes from `kind`
  currency: "USD", baseAmount: 1978, fxRate: "0.7912",   // base = GBP here; fxRate = 1 USD in GBP at write time
  fxSource: "manual" | "same" | "auto",       // manual: typed by the user (the only source until decision 11); auto: reference feed, later
  categoryId: "c_telecom",
  occurredAt: Timestamp, month: "2026-11",    // month: the budget month (honours monthStartDay)
  note: 🔒 string, counterparty: 🔒 string,
  source: "manual" | "invoice" | "import" | "wallet",   // "wallet" only once decision 13 is reversed
  walletTxId?: string, invoiceId?: string, refundOf?: txId,
  autoCategorized: bool, tags: string[],
  attachmentKey?: string,                     // receipt photo in R2
  deleted: false,                             // soft delete; the audit log keeps history
  createdAt ⚙, updatedAt ⚙, rev ⚙ }           // rev: incremented on each edit
```
IDs: manual `t_{uuid}`, wallet `w_{walletTxId}`, invoice `i_{invoiceId}_{paymentId}`.
Indexes: `(month, occurredAt desc)` · `(categoryId, occurredAt desc)` · `(deleted, occurredAt desc)`.

### 2.4 `pfm/{uid}/months/{YYYY-MM}` — rollup ⚙
```ts
{ income: 500000, expense: 140000, txCount: 37,
  cat: { c_rent: { e: 120000, i: 0, n: 1 }, c_food: { e: 20000, i: 0, n: 9 }, … },
  day: { "05": { i: 0, e: 4500 }, … },        // daily series for the cash-flow chart
  updatedAt }
```
Every tx write applies `increment` transforms to `income|expense`, `cat.{id}.e|i|n` and `day.{dd}`. An edit applies the
difference between old and new; a delete applies the negative. A nightly job rebuilds one random month per user from `tx`
and logs `pfm.rollup.drift` if the result differs. That guards against bugs, not normal operation.

### 2.5 `pfm/{uid}/budgets/{period}_{catId}`
```ts
{ categoryId: "c_food" | "_total", period: "2026-11",   // "_total" = whole-month spending cap
  limit: 100000, currency: "GBP",             // always the user's base currency; changing base currency converts open budgets once
  rollover: false,                            // carry unspent (or overspent) into next month
  carriedIn: 0 ⚙,
  alertsBp: [5000, 8000, 10000], firedBp: [5000] ⚙,      // -1 = the pace alert has fired
  recurring: true }                           // the cron copies it into the next period on day 1
```
Spending for a budget = `months/{period}.cat[catId].e` (refunds already netted out). No separate counter to drift.

### 2.5b `pfm/{uid}/recurring/{id}` — recurring entries
```ts
{ kind, amount, currency, categoryId, note 🔒, counterparty 🔒,
  rule: { freq: "monthly" | "weekly" | "yearly", day: 1, interval: 1 },   // e.g. rent on the 1st
  nextAt: "2026-12-01", endsAt?: null, paused: false,
  mode: "suggest" | "auto" }                  // suggest (default): a pending row the user confirms; auto: booked directly
```
On `nextAt` (user's time zone), the cron writes `tx/r_{id}_{date}` with `status: "suggested"`. A suggested row is left out of rollups
until confirmed, and the fixed ID makes the cron safe to re-run. Confirming applies the rollup increments and an audit entry.
`tx` gains `status: "booked" | "suggested"` (default `booked`).

### 2.6 ⏸ Wallet ledger (deferred, decision 13)
Not built now. Kept so wallet features can be added later without changing PFM's data model.
```ts
wallets/{uid}            { status: "active" | "frozen", pinHash ⚙, primaryCurrency, updatedAt ⚙ }
wallets/{uid}/balances/{CUR}  { balance ⚙, updatedAt ⚙ }      // one document per currency held, e.g. balances/USD, balances/SAR
wallets/{uid}/tx/{wtxId} { type: "transfer.in" | "transfer.out" | "purchase" | "bill" | "topup" | "withdraw" | "refund"
                                 | "fee" | "invoice.paid" | "invoice.received",
                           amount (signed), currency, balanceAfter, counterpartyUid?, counterpartyName?, mcc?,
                           invoiceId?, refundOf?, at, idemKey }
```
Any Worker op that changes a `wallets/{uid}/balances/{CUR}` document also writes the matching `pfm/{uid}/tx/w_{wtxId}` **in the same commit**
(§5.1). The sync cannot lag or drop a row.

### 2.7 `invoices/{invoiceId}` — top-level, so the payer can be resolved without the issuer's path
```ts
{ issuerUid, number: "INV-2026-0042",        // assigned at send time; unique per issuer (guarded by invoiceNumbers/, §5.6)
  status: "draft" | "sent" | "paid" | "overdue" | "cancelled",
  lang: "ar" | "en", currency: "JPY",         // one of the twelve accepted currencies (decision 8)
  taxLabel: "Consumption tax" | null,         // copied from settings at creation, editable per invoice
  issueDate: "2026-11-05", dueDate: "2026-11-19",   // dates in the issuer's time zone
  issuer: { name, contact, address 🔒, taxId 🔒, logoKey },   // snapshot, so later profile edits don't rewrite old invoices
  payoutAccounts: [{ id, type, label, holderName, bankName?, provider?, number 🔒, branch?, details? }],  // snapshot of the chosen accounts
  allowPartial: true,                         // decision 3; the issuer can switch it off before sending
  client: { name, contact, email?, phone?, taxId 🔒, sawaUid? },
  items: [{ description, qty: "2.5", unitPrice, discount?: {type:"pct",rate:"10"} | {type:"amt",minor},
            taxRate: "10" }],                 // typed or picked from the saved rates; "0" = no tax on this line. ≤ 200 lines
  invoiceDiscount?: {…}, taxInclusive: false, notes,
  totals ⚙: { subtotal, invoiceDiscount, netTotal, taxTotal, total, taxBreakdown[], amountPaid, amountDue },
  payLinkToken ⚙, sentAt ⚙, paidAt ⚙, cancelledAt ⚙, cancelReason,
  pdf ⚙: { key, hash, renderedAt },
  rev ⚙, createdAt ⚙, updatedAt ⚙ }
```
- Only `draft` invoices can be edited. Once `sent`, the content is frozen. A fix means cancel and reissue, the way accountants do it.
- Tax fields (`taxRate`, `taxInclusive`) must be `"0"`/false unless the issuer's `taxRegistered` is on (`applyTaxPolicy`).
  Rates are any value from 0 to 100 with up to 4 decimals. The PDF prints the rate exactly as typed, under the issuer's tax name.
- `fx` ⚙ `{ toBase: "0.9224", at, source }`: the invoice total in the issuer's base currency, used for the issuer's ledger and dashboard.
- `invoices/{id}/payments/{payId}` ⚙
  ```ts
  { amount, currency, at,
    method: "wallet" | "bank_transfer" | "mobile_money" | "cash" | "manual" | "card",   // card: only once PFM_CARD is on
    state: "pending" | "succeeded" | "failed" | "claimed" | "rejected",   // only "succeeded" counts toward amountPaid
    payerUid?,                                 // missing for a guest
    guest?: { name, email?, phone? } 🔒,      // a card payer without a Sawa account
    provider?: { name, intentId, last4?, brand? },   // card payments
    payoutAccountId?, reference?, proofKey?,   // a transfer the payer reported (§5.5)
    walletTxId?, decidedBy?, decidedAt? }
  ```
- `pfm/{uid}/invoiceNumbers/{number}` ⚙ `{ invoiceId }`. Created with `exists:false` when a number is assigned, so a number can never be used twice.
- Indexes: `(issuerUid, status, dueDate)` · `(issuerUid, createdAt desc)` · `(client.sawaUid, status)`.

### 2.8 `payLinks/{token}` ⚙
`{ invoiceId, issuerUid, createdAt, revoked }`. The token is 128 random bits in base64url. It is the only thing in a shared link
and reveals nothing by itself. Revoked on cancel and replaced on resend.

### 2.9 `pfm/{uid}/payoutAccounts/{id}` — accounts for receiving money (decision 6)
```ts
{ type: "sawa_wallet" | "bank" | "mobile_money" | "other",
  label: "Main account",                      // the issuer's own name for it
  holderName: "Khalid Ahmed",
  bankName?: "Deutsche Bank", branch?: "BIC DEUTDEFF",   // free text: any bank, any country
  provider?: "M-Pesa",                        // mobile money: any provider
  number 🔒: "DE89370400440532013000",         // account number, IBAN (mod-97 checked when it looks like one) or phone number
  numberLast4: "0123",                        // in clear, for lists: "•••• 0123"
  details?: "…",                              // "other": free text, ≤ 200 characters
  currency: "GBP" | "ANY",                    // the currency this account receives; "ANY" = converts on arrival
  isDefault: true, archived: false, createdAt ⚙, updatedAt ⚙ }
```
- `pa_wallet` (type `sawa_wallet`) is created, hidden, and switched on together with `PFM_WALLET` (decision 13). Until then, an issuer needs at least
  one bank, mobile-money or "other" account to send an invoice that clients can pay. `inv.send` warns if none is selected, but still allows
  "cash / in person" invoices.
- `cardPayout?` ⚙ `{ provider, connectedAccountId, status: "pending" | "active" | "rejected" }` on a **bank** account: set when the issuer
  completes the provider's onboarding (identity and bank checks). Unused until cards are switched on (decision 12).
- An invoice prints only the chosen accounts whose currency matches the invoice's, or `ANY` (`accountsForInvoice`). A GBP invoice never shows a USD-only account.
- Up to 10 accounts. Changing an account never changes invoices already sent: they keep their own snapshot.
- A full account number appears only in the issuer's own editor, the PDF and the pay page of an invoice that lists it. Lists show `numberLast4` only.

### 2.9b FX rates
**Now (decision 11):** `pfm/{uid}/fxLast/{FROM}_{TO}` ⚙ `{ rate, at }` remembers the last rate the user typed for each pair, to pre-fill the
next entry. Nothing else; no outside rates.

**Later, once a source is chosen:** `fx/{YYYY-MM-DD}` ⚙ — daily reference rates
`{ base: "USD", rates: { GBP: "0.7912", SAR: "3.7500", JPY: "151.237", … }, source, fetchedAt }`. The cron fetches them once a day
from a configurable provider (`PFM_FX_URL`; the provider is a deployment choice, not a product one). Any pair is computed through USD.
Rates are **reference only**: the user can always type the rate they actually got, and wallet conversions use a locked quote (§5.8).

### 2.10 `audit/{uid}/log/{seq}` ⚙ — append-only, hash-chained
```ts
{ seq: 1042, prevHash, hash,                  // hash = SHA-256(prevHash | canonical(entry))
  at, actor: uid | "system:wallet" | "system:cron", ip?: hashed,
  action: "tx.add" | "tx.update" | "tx.delete" | "budget.set" | "invoice.create" | "invoice.status" | "invoice.payment" | …,
  ref: "tx/t_…" | "invoices/…", before?: {changed fields}, after?: {changed fields} }   // 🔒 fields stay encrypted in here too
```
`audit/{uid}` holds `{ headSeq, headHash }`. Each audit write sets `currentDocument.updateTime` on it, so two concurrent writes
cannot fork the chain: one fails and retries. See §6.3 for anchoring.

### 2.11 Security rules
**P1 (as built):** no rules are added. `firestore.paste.rules` has no match for `pfm/` or `audit/`, so every client read and write
is denied, and the app reads through `pfm.*` ops, which decrypt the sealed fields for their owner. (The rules sketched in earlier
revisions, owner-only reads, are not needed until a client reads Firestore directly, e.g. for live invoice status in P4.)

---

## 3. API

House convention: `POST /api` with `Authorization: Bearer <Firebase ID token>` and a body of `{ op, ...payload }`. The response is
`{ ok: true, ... }` or `{ ok: false, code, msg }`. The REST column is the equivalent path if these are ever exposed as REST. Every
mutating op accepts `idemKey` (a client UUID), which is kept in `pfm/{uid}/idem/{key}` for 24 hours. A repeat returns the first response.

### 3.1 Ledger, categories, budgets, analytics

| op | REST | Payload → result |
|---|---|---|
| `pfm.tx.add` | `POST /v1/pfm/tx` | `{kind, amount: "1,250.50", currency?, fxRate?, categoryId, occurredAt, note?, counterparty?, tags?}` → `{tx}`. `currency` defaults to the base currency; `fxRate` (typed by the user) overrides the reference rate |
| `pfm.tx.update` | `PATCH /v1/pfm/tx/{id}` | `{id, rev, …changed}` → `{tx}`. `409 stale` if `rev` doesn't match. Wallet rows: only `categoryId`, `note`, `tags` |
| `pfm.tx.delete` | `DELETE /v1/pfm/tx/{id}` | `{id, rev}` → soft delete. Wallet and invoice rows can't be deleted, only hidden |
| `pfm.tx.list` | `GET /v1/pfm/tx?month=&cat=&q=&cursor=` | → `{items, cursor}`, 50 per page. Decrypts 🔒 fields for the caller |
| `pfm.recurring.upsert` / `.pause` / `.delete` | `PUT/DELETE /v1/pfm/recurring/{id}` | §2.5b |
| `pfm.tx.confirm` | `POST /v1/pfm/tx/{id}/confirm` | A suggested row → booked (optionally with an edited amount or date) |
| `pfm.tx.split` | `POST /v1/pfm/tx/{id}/split` | `{id, parts:[{amount, categoryId}]}`. The parts must add up to the total |
| `pfm.cat.upsert` / `pfm.cat.archive` | `PUT/DELETE /v1/pfm/categories/{id}` | |
| `pfm.rule.upsert` | `PUT /v1/pfm/rules/{id}` | `{match:{type?, counterpartyUid?, contains?, mcc?}, categoryId, applyToPast?: bool}` |
| `pfm.budget.set` | `PUT /v1/pfm/budgets/{period}/{cat}` | `{period, categoryId, limit, rollover?, recurring?, alertsBp?}` |
| `pfm.summary` | `GET /v1/pfm/summary?from=2026-06&to=2026-11` | → `{months:[{month, income, expense, net, savingsRateBp}], byCategory, budgets:[budgetStatus…]}` |
| `pfm.export` | `GET /v1/pfm/export?from&to&format=csv` | As built (§7f): `{filename, csv, rows, truncated}` in the response; a signed R2 link once R2 exists |
| `pfm.tx.receipt.set` / `.get` / `.delete` | — | One sealed receipt photo per entry (§7f) |
| `pfm.fx.rate` | `GET /v1/pfm/fx?from=USD&to=SAR&date=` | → `{rate, source:"last_used"|"reference", at}`. Now: the user's own last rate for the pair, or `null`. Reference rates later (decision 11) |
| `pfm.settings.set` | `PATCH /v1/pfm/settings` | `{baseCurrency?, tz?, locale?, taxRegistered?, taxLabel?, taxRates?, defaultTaxRateId?, defaultInvoiceCurrency?, invoicePrefix?, defaultDueDays?, defaultAllowPartial?, issuerProfile?}`. Turning `taxRegistered` off does not touch invoices already sent. Changing `baseCurrency` re-bases rollups in a background job (§5.8) |
| `pfm.logo.set` | `PUT /v1/pfm/logo` | Body: the image bytes (≤ 512 KB). The server checks the real type (PNG/JPEG/WebP, no SVG), stores it at `logos/{uid}/{sha256}`, and sets `issuerProfile.logoKey`. `pfm.logo.delete` removes it |
| `pfm.account.upsert` | `PUT /v1/pfm/accounts/{id}` | A receiving account; checked by `validatePayoutAccount`. → the account with the number masked |
| `pfm.account.archive` | `DELETE /v1/pfm/accounts/{id}` | Not allowed for `pa_wallet` |
| `pfm.account.reveal` | `GET /v1/pfm/accounts/{id}/number` | The full number, for the owner's edit screen only. Logged in the audit chain |

### 3.2 Invoices

| op | REST | Notes |
|---|---|---|
| `inv.create` | `POST /v1/invoices` | Creates a **draft**: `{client, items, …, payoutAccountIds?, allowPartial?}`. Defaults come from settings. Returns `{invoice, totals}` |
| `inv.update` | `PATCH /v1/invoices/{id}` | Drafts only. `{id, rev, …}` |
| `inv.preview` | `POST /v1/invoices/preview` | Totals without saving. The editor calls it while the user types (debounced 300 ms) |
| `inv.send` | `POST /v1/invoices/{id}/send` | draft → sent. Assigns the yearly `number` (§5.6), snapshots the logo and chosen accounts, creates the pay link, renders the PDF, and pushes to `client.sawaUid` if set. `{id, channels:["link","email","whatsapp"]}` → `{payUrl, pdfUrl, shareText}` |
| `inv.cancel` | `POST /v1/invoices/{id}/cancel` | `{id, reason}`. Revokes the pay link. Not allowed after any payment (refund instead) |
| `inv.markPaid` | `POST /v1/invoices/{id}/payments` | Issuer records a payment received outside Sawa: `{id, amount, method:"cash"|"bank_transfer"|"mobile_money", payoutAccountId?, reference?, paidAt, idemKey}` |
| `inv.claim.decide` | `POST /v1/invoices/{id}/payments/{payId}/decide` | Issuer confirms or rejects a transfer the payer reported: `{decision:"confirm"|"reject", amount?, note?}`. Confirming runs the normal payment commit (§5.5) |
| `inv.pdf` | `GET /v1/invoices/{id}/pdf` | → `{url}`: a signed `/pfm/file` link valid for 15 minutes. Cached by content hash |
| `inv.list` | `GET /v1/invoices?status=&role=issued|received` | |
| `inv.public` | `GET /v1/pay/{token}` | **No auth.** → `{number, issuer:{name, logoUrl}, total, amountDue, currency, dueDate, status, items, allowPartial, payoutAccounts, methods, walletFrom}` (from `payOptions()`: today `methods` is `wallet` and/or `transfer`). Hides the issuer's contact and address; shows the tax ID only if the invoice includes tax. Rate-limited per IP |
| `inv.pay` ⏸ | `POST /v1/pay/{token}` | Auth required (Sawa user). `{token, amount?, method:"wallet", pin, idemKey}` → `{status, amountDue, receiptTxId}`. §5.2. ⏸ Off until the wallet ledger exists (`PFM_WALLET`, decision 13) |
| `inv.quote` ⏸ | `POST /v1/pay/{token}/quote` | Auth required. `{token, fromCurrency, amount?}` → `{quoteId, rate, debit:{currency, minor}, fee?, expiresAt}`. Single use, 60 s. Used when the payer pays from a balance in another currency (§5.8). ⏸ Off until decision 11 (`PFM_FX_QUOTES`) |
| `inv.checkout` ⏸ | `POST /v1/pay/{token}/checkout` | ⏸ Off until a card provider is chosen (`PFM_CARD`). **No auth needed**. `{token, amount?, payer:{name, email?, phone?}, idemKey, captcha}` → `{checkoutUrl}` or `{clientSecret}` from the card provider. §5.4 |
| `inv.claim` | `POST /v1/pay/{token}/claim` | Auth optional. "I've paid by transfer": `{token, amount, payoutAccountId, reference, proof? (image), payer:{name, phone?}}` → `{payId, state:"claimed"}`. §5.5 |
| `pfm.account.cardOnboard` ⏸ | `POST /v1/pfm/accounts/{id}/card-onboarding` | Starts the provider's onboarding for one bank account → `{onboardingUrl}`. Sets `cardPayout` when the provider confirms |
| — ⏸ | `POST /pfm/webhook/{provider}` | Card provider webhook. Signature checked against `PFM_PAY_WEBHOOK_SECRET`; the payment is looked up by the provider's intent ID, never by data in the body alone |

`inv.send` example response:
```json
{ "ok": true, "number": "INV-2026-0042", "status": "sent",
  "payUrl": "https://www.sawaaap.com/pay/9fK2xQ…", "pdfUrl": "https://…/pfm/file?k=…&e=…&s=…",
  "shareText": "فاتورة INV-2026-0042 من استوديو خالد بمبلغ 5,705.88 ر.س. — ادفع عبر سوا: https://www.sawaaap.com/pay/9fK2xQ…" }
```

⏸ = designed, behind a switch that is off (decisions 10, 11 and 13). The op answers `feature_off` until switched on.

Error codes: `bad_amount`, `too_precise`, `bad_currency`, `bad_items`, `bad_transition`, `not_payable`, `overpay`,
`insufficient_funds`, `bad_pin`, `pin_locked`, `stale` (409), `rate_limited` (429), `self_pay`,
`partial_not_allowed`, `tax_not_registered`, `bad_rate`, `bad_fx_rate`, `quote_expired`, `bad_account`, `bad_logo`, `card_unavailable`, `claim_pending`, `feature_off`.

---

## 4. UI/UX

### 4.1 Navigation
`Wallet` tab → segmented control **Wallet | Accountant**. The Accountant never reads the wallet's (client-side) balance; it only lives next to it. The Accountant has 4 sub-tabs: **Overview · Ledger · Budgets · Invoices**,
and a floating **＋** button that opens a quick-add sheet (Expense / Income / Invoice). Arabic first (RTL), with Western digits for money (as in C200).

### 4.2 Component tree
```
AccountantScreen
├─ MonthPicker                         ‹ Nov 2026 ›   (budget month, honours monthStartDay)
├─ OverviewTab
│  ├─ KpiRow: Income · Expenses · Net · Savings rate      (from months/{m})
│  ├─ CashFlowChart        daily bars, income vs expense, cumulative net line
│  ├─ CategoryBreakdown    ranked bars (not a pie: easier to read on phones and in RTL), tap → filtered Ledger
│  ├─ BudgetStrip          top 3 budgets nearest their limit
│  ├─ TrendChart           6-month net and savings rate
│  └─ InvoiceSummary       outstanding · overdue (red) · paid this month
├─ LedgerTab
│  ├─ SearchBar + FilterChips (category, source: manual/invoice, type)
│  ├─ RateBanner           "2 entries need an exchange rate" → add rates
│  ├─ ⏸ SyncBanner         (with the wallet, later) "Wallet sync on · 3 new transactions categorised" → review
│  ├─ TxList (grouped by day, virtualised)  TxRow: icon · counterparty · category chip · amount (green +/red −) · ⚡ synced
│  └─ TxSheet              edit category / note / split / receipt photo / "always categorise X as Y" → creates a rule
├─ BudgetsTab
│  ├─ BudgetCard×N         meter (green < 80 %, amber 80–100 %, red > 100 %), remaining, "on pace" or "≈ 112 % by month end"
│  └─ BudgetEditor         limit, rollover, recurring, alert thresholds
├─ InvoicesTab
│  ├─ StatusFilter         All · Draft · Sent · Overdue · Paid · Cancelled   |  Issued / Received
│  ├─ ClaimsBanner         "2 transfers to confirm" → ClaimReview (amount, reference, proof photo, account) → Confirm / Reject
│  ├─ InvoiceRow           client · number · amount due (shows "partly paid" when 0 < paid < total) · due date · StatusBadge
│  └─ InvoiceEditor (full screen, see 4.3) / InvoiceDetail (payment timeline, share, PDF, record payment, cancel)
└─ BusinessSettings  (gear icon on InvoicesTab)
   ├─ LogoPicker           pick or take a photo → crop to fit (≤ 1024 px, re-encoded as WebP on the device) → preview on a sample invoice
   ├─ IssuerProfile        name, contact, address, tax ID
   ├─ TaxSettings          "I charge tax" toggle → tax name (free text: VAT, GST, TVA…), tax ID, and the issuer's own saved rates
   │                       (typed by hand, e.g. Standard 19 %, Reduced 7 %). Off hides all tax fields. No rate is suggested
   ├─ Currencies           base currency for reports · default invoice currency (both searchable lists of all ISO currencies)
   ├─ Numbering            prefix + preview "INV-2026-0043 (resets every January)"
   └─ ReceivingAccounts    list: Al Rajhi SAR •••• 3000 · Chase USD •••• 6789 · Vodafone Cash EGP •••• 5678 · ＋ Add account
PublicPayPage (/pay/{token})   logo + invoice → payment details (copy buttons) → I've paid (no account needed)   [+ Sawa Wallet, + card: later]
```

### 4.3 Invoice editor
One scrolling form with a sticky **totals bar** at the bottom: `Total 5,705.88 ر.س. ▴` (in the invoice's currency). Tap it to expand the full breakdown.
0. **Currency:** a chip at the top (default from settings). Tap → the twelve accepted currencies (decision 8). Prices are typed in this currency, and the decimal places follow it (no decimals for JPY, 3 for KWD).
1. **Client:** search Sawa contacts (sets `client.sawaUid`, enabling in-app delivery and one-tap pay), or enter one by hand. Recent clients come first.
2. **Items:** rows with description, qty, unit price, then "＋ discount" and the tax chip. The chip offers the issuer's saved rates plus **"Custom…"**, a numeric field for any rate (up to 4 decimals). It starts empty (no tax) unless the issuer set a default saved rate. The tax chip and the "prices include tax" toggle **appear only when the user charges tax**. Otherwise a one-line hint links to the setting. Swipe to delete, drag to reorder. Saved items can be reused.
3. **Terms:** issue date, due date (presets: on receipt / 7 / 14 / 30 days), invoice discount, prices include tax (registered users only), "Allow partial payments" (on by default), notes.
4. **Get paid by:** chips for the saved receiving accounts, with the defaults pre-selected. At least one is needed for clients to pay remotely; otherwise the invoice is marked "pay in person". "＋ Add account" opens the account form without leaving the editor.
5. **Actions:** `Save draft` · `Preview PDF` · **`Send`** → share sheet: WhatsApp / Telegram (text + link), Email (PDF attached), Copy link, Sawa chat (an invoice card in the conversation).

The header shows the logo and the number the invoice will get (`INV-2026-0043`, final once sent).
Totals come from `inv.preview` (debounced). While a request is in flight, the bar shows the last server result with a subtle spinner.
The client never shows totals computed in the browser, so what the user sees always matches the PDF. Validation is inline: an
amount with too many decimals is flagged at the field.

### 4.4 Recording income and expenses (what the user sees)
Now, without the wallet:
1. **Quick add** (＋): amount pad first, then category (the 6 most-used categories as chips), date (today by default), and an optional note,
   counterparty or receipt photo. Two taps for a repeat entry ("Same as last time: Rent").
2. **Recurring entries:** salary, rent, subscriptions. "Repeat monthly on the 1st" creates the next entry automatically as a *suggested* row
   that the user confirms with one tap, so the ledger never contains money that didn't move.
3. **Invoice payments** the issuer confirms are added to the ledger as income automatically (`source: "invoice"`).
4. Budget alerts arrive as push messages, as below.

### 4.4b ⏸ Auto-sync flow (with the wallet, later)
1. First open: "Track wallet activity automatically?" → On (default) or Off. The choice is in settings.
2. Each wallet payment appears in the Ledger immediately, marked ⚡, with a category from the user's rules or a default.
3. The SyncBanner counts rows in `c_uncategorized`. "Review" shows a one-by-one card stack: pick a category, with an "always for this payee" checkbox.
4. Budget alerts arrive as push messages: "Food: 82 % used, €180.00 left, 15 days to go".
5. A wallet payment in another currency is logged in its own currency, with the converted base amount beneath it in grey (`$25.00 · ≈ €23.06`).

### 4.5 Paying an invoice (payer)
The pay page and the chat card show the issuer's logo, name, the amount due and the choices `payOptions()` returns. **Today that is only the transfer option (third below)**:
- ⏸ **Sawa Wallet** (later, decision 13; signed in): **Pay 4,705.88 ر.س.** → bottom sheet with the balance in that currency → PIN pad (the existing 6-digit wallet PIN) → receipt.
  With too little balance in the invoice currency it offers "Top up" or "Pay by transfer". *Later (decision 11):* paying from a balance in another
  currency at a locked quote, e.g. "Pay from USD: $1,254.90 (1 USD = 3.7500 SAR, valid 60 s)".
- ⏸ **Card, no account needed** (later, decisions 10 and 12): name and email or phone for the receipt → the provider's hosted card form → back to
  `/pay/{token}?done=1`, which waits for the webhook result (polling `inv.public` every 2 s, up to 60 s) → receipt by email or SMS.
  Afterwards a "Create a Sawa account to keep your receipts" offer (optional).
- **Bank or mobile money:** the issuer's chosen accounts, each with a copy button for the number, plus the invoice number to use as
  the payment reference → after transferring, **"I've paid"** → amount, reference, optional screenshot → "Sent to the issuer for confirmation".

**Amount field:** shows the full amount due. When partial payments are allowed (the default) the payer can lower it. Otherwise the field is locked.
Both parties get a push; the issuer's invoice updates live through `onSnapshot`: **partly paid · 100,000 of 580,000**, then **Paid**.

---

## 5. Key flows

### 5.1 ⏸ Wallet → ledger auto-sync (deferred, decision 13)
```js
// Inside every wallet-mutating op (transfer, purchase, invoice payment …), after computing the new balance:
const evt = { walletTxId, type, amount, currency, at, counterpartyUid, counterpartyName, mcc, invoiceId, refundOf };
const writes = [
  ...walletWrites,                                         // wallets/{uid} balance with updateTime precondition, wallets/{uid}/tx/{id}
];
if (settings.autoSync.enabled) {
  const tx = walletEventToTx(evt, rules);                  // pfm-core.mjs; id = "w_" + walletTxId
  if (tx) writes.push(
    { update: { name: `${DOC_ROOT}/pfm/${uid}/tx/${tx.id}`, fields: toFsFields(await sealTx(tx, uid, env)) },
      currentDocument: { exists: false } },                // a duplicate event fails the whole commit, so it is never counted twice
    rollupIncrement(uid, tx, +1),                          // months/{m}: income|expense, cat.{id}, day.{dd}
    ...auditWrites(uid, "tx.add", tx));
}
await fsCommit(token, writes);                             // all or nothing
```
Because the ledger row is written in the wallet's own commit, there is no queue, no retry worker and no reconciliation job.
Budget alerts run afterwards with `ctx.waitUntil(checkBudgetAlerts(uid, month, categoryId))`. They read the rollup, call
`budgetStatus()`, and if there are new alerts, push them and add them to `firedBp` (an `appendMissingElements` transform, so
two writers cannot double-alert).

### 5.2 ⏸ One-tap wallet settlement `inv.pay` (deferred, decision 13)
```js
async function opInvoicePay(uid, p, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const link = await fsGet(token, `payLinks/${p.token}`);
  if (!link || link.revoked) throw new PfmError("not_found");
  if (link.issuerUid === uid) throw new PfmError("self_pay");
  await verifyWalletPin(uid, p.pin, env);                 // counts failures; locks for 15 min after 5

  for (let attempt = 0; attempt < 3; attempt++) {         // optimistic concurrency
    const [inv, payer, payee, head1, head2] = await batchGet(token, [
      `invoices/${link.invoiceId}`, `wallets/${uid}`, `wallets/${link.issuerUid}`, `audit/${uid}`, `audit/${link.issuerUid}`]);
    const amount = p.amount ?? (inv.totals.total - inv.totals.amountPaid);
    const next = applyPayment({ status: inv.status, total: inv.totals.total, amountPaid: inv.totals.amountPaid, allowPartial: inv.allowPartial }, amount);
    // Today the payer pays from their balance in the invoice currency. A quoteId (paying from another currency)
    // is refused with feature_off until PFM_FX_QUOTES is on (decision 11).
    if (p.quoteId && env.PFM_FX_QUOTES !== "1") throw new PfmError("feature_off");
    const debit = p.quoteId ? await useQuote(p.quoteId, uid, inv.currency, amount) : { currency: inv.currency, minor: amount };
    if (payer.balance < debit.minor) throw new PfmError("insufficient_funds");   // payer = wallets/{uid}/balances/{debit.currency}

    const wOut = `${p.idemKey}_o`, wIn = `${p.idemKey}_i`, at = new Date().toISOString();
    const writes = [
      // The payment record is the idempotency guard: a second identical request fails here.
      create(`invoices/${inv.id}/payments/${p.idemKey}`, { amount, method: "wallet", payerUid: uid, walletTxId: wOut, at }),
      patch(`invoices/${inv.id}`, { "totals.amountPaid": next.amountPaid, "totals.amountDue": next.amountDue, status: next.status,
             ...(next.status === "paid" && { paidAt: at }) }, { updateTime: inv._updateTime }),
      patch(`wallets/${uid}`,            { balance: payer.balance - amount }, { updateTime: payer._updateTime }),
      patch(`wallets/${link.issuerUid}`, { balance: payee.balance + amount }, { updateTime: payee._updateTime }),
      create(`wallets/${uid}/tx/${wOut}`,            { type: "invoice.paid",     amount: -amount, invoiceId: inv.id, counterpartyUid: link.issuerUid, at }),
      create(`wallets/${link.issuerUid}/tx/${wIn}`,  { type: "invoice.received", amount: +amount, invoiceId: inv.id, counterpartyUid: uid, at }),
      ...ledgerWritesFor(uid, wOut, "expense", "c_invoices_paid"),   // §5.1 for both sides
      ...ledgerWritesFor(link.issuerUid, wIn, "income", "c_invoices"),
      ...auditWrites(head1, uid, "invoice.payment", …), ...auditWrites(head2, link.issuerUid, "invoice.payment", …),
    ];
    try { await fsCommit(token, writes); return { status: next.status, amountDue: next.amountDue, receiptTxId: wOut }; }
    catch (e) {
      if (/ALREADY_EXISTS/.test(e.message)) return replayIdem(p.idemKey);   // same request, already done
      if (/FAILED_PRECONDITION/.test(e.message)) continue;                 // someone else wrote first: re-read and retry
      throw e;
    }
  }
  throw new PfmError("busy");
}
```
After the commit: push to the issuer ("INV-2026-0042 paid: 4,705.88 ر.س."), and in `waitUntil` re-render the PDF with the **PAID** badge.

### 5.3 Shared payment commit
§5.5 (confirmed transfer) and `inv.markPaid` (today), and later §5.2 (wallet) and §5.4 (card webhook), all end in one function,
`commitInvoicePayment(inv, payment)`. It uses `applyPayment()` (which enforces `allowPartial` and refuses overpayment) and writes
the payment record, the invoice totals and status, the issuer's ledger income row (`i_{invoiceId}_{payId}`, category `c_invoices`) and the audit entries.
Only the wallet path (later) also moves wallet balances. One code path keeps every method consistent, and adding a method later doesn't touch the others.

### 5.4 ⏸ Card payment by a guest (off: decisions 10 and 12)
Kept so the invoice and payment model already fits cards. Nothing below is built until a provider is chosen.

```
Payer (no account)        Worker                                   Card provider            Firestore
 │ POST /pay/{t}/checkout  │                                          │                        │
 │ {amount, payer, idem}──►│ rate limit (IP) · captcha · applyPayment() as a dry run (allowPartial, overpay)
 │                         │ create payments/{payId} state=pending ───┼───────────────────────►│
 │                         │ createIntent(amount, currency,           │                        │
 │                         │   metadata:{invoiceId, payId}) ─────────►│                        │
 │ ◄── checkoutUrl ────────│                                          │                        │
 │ pays on hosted page ───────────────────────────────────────────────►│                        │
 │                         │ ◄── webhook payment.succeeded (signed) ──│                        │
 │                         │ verify signature → load payments by intentId → amount and currency match?
 │                         │ commitInvoicePayment (precondition: payment still pending) ───────►│
 │                         │ receipt email/SMS · push to issuer                                 │
```
- Card data never touches Sawa: the provider hosts the card form, so Sawa stays out of PCI DSS card-data scope.
- Webhooks are idempotent: a second `succeeded` finds `state != pending` and stops.
- Pending payments older than 24 hours are marked `failed` by the cron. If two payers pay in full at once, the second succeeds at the
  provider but fails `applyPayment` (overpay). It is then refunded automatically through the provider, and both parties are told.
- **Payout straight to the issuer's bank (decision 12).** The charge is made on the issuer's own connected account at the provider
  (the "connected account" or "split settlement" model that marketplace providers offer). The provider settles to the issuer's verified bank
  account on its normal schedule. **Sawa never holds the money**, so it needs no money-transmitter licence for card flows and the wallet balance is untouched.
  - Before card is offered on an invoice, the issuer onboards one of their bank accounts with the provider (`pfm.account.cardOnboard`:
    identity and bank checks happen on the provider's pages). Until `cardPayout.status = "active"`, `payOptions()` shows no card button.
  - The issuer's ledger records the **gross** amount as income (`c_invoices`) and the provider fee as an expense (`c_fees`), both in the invoice currency.
    The provider's payout report reconciles them later (`payments/{id}.provider.payoutId`).
  - Refunds and chargebacks are taken from the issuer's provider balance, not from Sawa. A chargeback reopens the invoice (`paid` → `overdue`)
    with an audit entry, and both parties are told.
- **Provider:** not chosen yet (§8). The code goes behind a small interface, `createIntent / verifyWebhook / refund`, so the
  provider can change without touching invoice logic. Which card currencies and issuer countries are accepted depends on the provider and on local
  regulation. The checkout charges in the invoice currency where the provider supports it, and otherwise shows the converted amount before payment. Until a provider is live, `PFM_CARD` is off, `methods` omits `card`, and the page shows wallet and transfer options only.

### 5.5 Bank and mobile-money transfers (decision 6)
Money sent straight to the issuer's bank or mobile-money account never passes through Sawa, so Sawa cannot see it arrive. The flow is therefore
**payer reports → issuer confirms**:
1. The payer taps "I've paid" and enters the amount, reference and an optional screenshot (R2 `proofs/…`, image check as for logos).
   → `payments/{payId}` with `state: "claimed"`. The invoice does **not** change yet. A claim cannot exceed the amount due (counting other open claims).
2. The issuer gets a push and sees the claim in ClaimsBanner, with the screenshot and the account it was sent to.
3. **Confirm** → `commitInvoicePayment` (the amount can be corrected first). **Reject** → `state: "rejected"` with a note, and the payer is told.
4. The issuer can also record a transfer directly with `inv.markPaid`, without waiting for a claim.
5. Open claims older than 7 days are flagged on the issuer's dashboard; they never expire on their own.

### 5.6 Invoice numbering (decision 2)
At `inv.send`, inside one commit:
```js
const issueDate = inv.issueDate || localDate(settings.tz);                  // "2026-11-05"
const year = issueDate.slice(0, 4);
const seq = (settings.invoiceSeq?.[year] || 0) + 1;                         // the year's counter; a new year starts at 1
const { number } = invoiceNumber(settings.invoicePrefix, issueDate, seq);    // "INV-2026-0043"
writes.push(
  patch(`pfm/${uid}`, { [`invoiceSeq.${year}`]: seq }, { updateTime: settings._updateTime }),  // two sends at once: one retries
  create(`pfm/${uid}/invoiceNumbers/${number}`, { invoiceId: inv.id }),                       // exists:false: never reused
  patch(`invoices/${inv.id}`, { number, status: "sent", … }, { updateTime: inv._updateTime }));
```
- Drafts have no number, so deleted drafts leave no gaps. A cancelled invoice keeps its number, as auditors expect.
- An issuer can backdate an invoice's issue date only within the current or previous year, and only before sending.
- Changing the prefix applies to the next number. The sequence keeps counting: `INV-2026-0043` → `KDS-2026-0044`.

### 5.7 Logo (decision 5)
- The device picks or takes a photo, crops it, and re-encodes it to WebP at up to 1024 px, which usually comes to under 100 KB.
- `pfm.logo.set` → `sniffLogo()` checks the real bytes (PNG/JPEG/WebP only; SVG is refused because it can carry script) and the size (≤ 512 KB)
  → R2 `logos/{uid}/{sha256}.{ext}` → `issuerProfile.logoKey`. The hash in the name means a new logo never overwrites a file an old invoice uses.
- `inv.send` copies `logoKey` into the invoice. The PDF step reads it from R2 and inlines it as a `data:` URI, because the renderer has all network
  access blocked. The pay page loads it through a signed `/pfm/file` link.

### 5.8 Multiple currencies (decision 8)
| Where | Rule |
|---|---|
| **Entering a transaction** | The user picks any of the twelve accepted currencies (decision 8). For a currency other than the base, the user types the rate (pre-filled with their own last rate for that pair, `fxLast`). If they don't know it, they can save the entry as "rate pending": it shows in the ledger, is left out of base-currency totals, and is flagged until a rate is added. *Later:* a daily reference rate pre-fills the field (decision 11). `baseAmount = convert(amount, currency, base, fxRate)` is fixed at write time |
| **Wallet transactions** ⏸ | (Later, decision 13.) A wallet payment in the base currency needs no rate. One in another currency asks for a rate the same way as a manual entry. Wallet-to-wallet conversion is off until decision 11; when it arrives, the quote's exact rate is stored on the row |
| **Dashboards and budgets** | Everything in base currency from `baseAmount`. Rows still waiting for a rate are left out and counted (`ratePending`), with a banner: "2 entries need an exchange rate". A "By currency" toggle shows the original amounts per currency (`summarize().byCurrency`) |
| **Invoices** | Any accepted currency. Totals, rounding and decimal places follow that currency. The issuer's ledger records income in the invoice currency, with `baseAmount` at the rate on the **payment** date, as accountants do |
| **Paying across currencies** ⏸ | Off until decisions 11 and 13. Today the payer pays by transfer in the invoice currency, to an account in that currency. Later: `inv.quote {token, fromCurrency}` → `{quoteId, rate, debit, expiresAt}` (60 s, stored at `quotes/{id}`, single use). `inv.pay {…, quoteId}` debits the payer's other balance and credits the issuer in the invoice currency. Exactly one conversion, at the shown rate. The FX margin, if any, is shown in the quote, never hidden in the rate |
| **Receiving accounts** | Each has a currency; an invoice prints only matching ones (§2.9) |
| **Changing base currency** | Allowed at any time. A background job recomputes `baseAmount` for every row at each row's own date rate (or keeps manual rates where the row's currency equals the new base) and rebuilds the rollups. The UI shows "Converting history…" until it finishes |
| **Display** | Symbol, placement and decimals come from `Intl.NumberFormat` for the user's language; digits are always Western. The PDF uses the invoice's language |

Exact conversion: `convert(minor, from, to, rate)` multiplies with BigInt, adjusts for the two currencies' decimal places, and rounds once (half away from zero). `fx/` rates are text, so `"151.237"` stays exactly that.

### 5.9 Cron (adds to the existing `*/5` schedule, at a cheap cadence)
- **Overdue sweep** (hourly slot): query `invoices where status == "sent" and dueDate < today(issuer tz)` → `overdue` + audit + push. Reminders are sent 3 days before and on the due date (opt-in).
- **Recurring entries** (hourly slot): due `recurring/*` → suggested rows (§2.5b), plus a push: "Rent €900 due today — confirm?".
- **Recurring budgets** (on the 1st, per user time zone): copy `recurring: true` budgets into the new period, adding `carriedIn` for rollover.
- **Audit anchor** (daily): see §6.3.
- ⏸ **FX reference rates** (daily, later): fetch into `fx/{date}` (§2.9b). If the fetch fails, the form shows the last date and asks the user to confirm or type a rate.
- ⏸ **Stale card payments** (hourly, later): `pending` payments older than 24 h → `failed` (after checking the provider's status).

---

## 6. Security & compliance

### 6.1 In transit
TLS 1.2+ to Cloudflare and from the Worker to Google APIs (all HTTPS). Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to `Sawa-app/_headers` (not there today). PDFs and exports are
reached only through HMAC-signed links that expire in 15 minutes. The R2 bucket has no public access.

### 6.2 At rest
- Firestore and R2 encrypt everything at rest (Google- and Cloudflare-managed AES-256).
- **Application-level field encryption** on top for the most sensitive free text: notes, counterparty names, tax IDs and
  addresses (🔒 above). AES-256-GCM, key = HKDF(`PFM_KEK_v{n}` Worker secret, uid), uid bound in as AAD
  (`sealField` / `openField` in `pfm-core.mjs`). A leaked Firestore export or a mis-written rule then exposes amounts and
  dates but not who or what.
  - Amounts and categories stay in clear text on purpose: the server aggregates them, and access is limited by rules to their owner.
  - Key rotation: add `PFM_KEK_v2` and set it as current. Reads accept both versions; a background job re-seals rows when touched.
  - Account deletion (existing `purgeWork`): delete `pfm/{uid}`, `audit/{uid}` and R2 `invoices/{uid}/`. Issued invoices that a payer
    paid keep a minimal record on the payer's side (number, amount, date), which tax rules need.
- **Secrets** live only in Worker secrets (`PFM_KEK_v1`, `PFM_LINK_KEY`), per HANDOFF rule §1, and are never sent to the client.

### 6.3 Immutable audit log
- Every mutating op writes its audit entry **in the same commit** as the change: no change without a log, no log without a change.
- Entries are hash-chained (`auditEntry` / `verifyChain`). Firestore rules forbid client writes, and the Worker has no update or delete path for `audit/`.
- **Anchoring:** a daily cron writes `{uid, headSeq, headHash}` for every user changed that day into R2 `audit-anchors/{date}.jsonl`,
  with **R2 bucket locks** (retention rule). Even someone with the service-account key cannot rewrite history without the
  chain no longer matching a locked anchor.
- `pfm.audit.verify` (admin/support) re-walks a user's chain and checks it against the anchors.
- Users see their own history ("Activity" in TxSheet and InvoiceDetail).

### 6.4 Abuse and fraud
- Rate limits (reusing `rl*`): `inv.public` 60/min per IP, `inv.pay` 10/min per user, `inv.send` 50/day per user, with stricter limits for unverified accounts (HANDOFF: unverified numbers get no money features).
- (Later, with the wallet) The wallet PIN is required for every wallet payment, with a server-side hash, attempt counter and lockout.
- The pay page shows the issuer's **verified** name and a warning when the issuer account is under 7 days old.
- Guest checkout: captcha, 5 checkouts per invoice per hour, 20 per IP per day, and the amount must be ≤ the amount due. The provider's own fraud checks (3-D Secure) are required.
- Transfer claims: 5 open claims per invoice; proof images go through the same check as logos.
- Receiving accounts: changing an account's number sends a push and an email to the owner ("Your Deutsche Bank account details were changed") and is logged. That gives a hijacked account little time to redirect payments unnoticed. Invoices already sent keep their original account snapshot.
- Every display path escapes HTML (the template uses `esc()`). The PDF renderer runs with JavaScript off and all network requests blocked.

---

## 7. Code in this folder

| File | What it is | Status |
|---|---|---|
| `pfm-core.mjs` | The accepted currencies (`ALLOWED_CURRENCIES`, `currencyExp` with decimals from Intl), exact `convert` between currencies, typed rates (`toRate` / `rateText`), `payOptions` (what the pay page offers, with the card and FX switches), money parsing (including Arabic-Indic digits), `computeInvoice` (line and invoice discounts, exclusive or inclusive tax, tax per rate), `allocate`, status machine, `applyPayment` (with `allowPartial`), `invoiceNumber` / `localDate` (yearly numbering), `applyTaxPolicy`, `validatePayoutAccount` (with IBAN check) / `maskNumber`, `sniffLogo`, `budgetStatus` (thresholds, variance, pace), `summarize`, `walletEventToTx`, audit hash chain, field encryption | Tested: `node pfm/pfm-core.test.mjs` (29 tests) |
| `invoice-html.mjs` | Self-contained invoice template, Arabic RTL and English, any currency (Intl formatting), issuer's own tax name: logo, pay QR block, receiving accounts | Rendered to PDF with Chromium: Arabic in SAR with 15 % VAT, English in USD with 8.875 % sales tax (`samples/`) |
| `invoice-pdf.mjs` | Worker pipeline: recompute totals → HTML → hash → R2 cache → Browser Rendering → signed link, and `serveSignedFile` | Not deployed: needs the bindings below |
| `projects-core.mjs` | Projects & cost estimator: BOQ lines, line and project variance, forecast, margin, alert keys, lifecycle guards (spec: `PROJECTS.md`) | Tested: `node pfm/projects-core.test.mjs` (15 tests) |
| `projects-migrations.mjs` | Versioned, idempotent schema migrations for the Projects subtree, tracked in `pfm/{uid}/meta/projects` | Tested: `node pfm/projects-migrations.test.mjs` (7 tests) |
| `pfm-worker.mjs` (Projects section) | P6b Worker ops `pfm.proj.*`, and the purge of the projects subtree | Tested: `node pfm/projects-worker.test.mjs` (10 tests) |

How `computeInvoice` handles tax (the rule the code and tests enforce):
1. `gross = round(qty × unitPrice)` per line (BigInt, half away from zero).
2. Line discount (percentage or fixed amount, capped at gross) → **row amount** (shown on the invoice).
3. The invoice discount is computed on the sum of row amounts and **spread over lines in proportion** (largest remainder,
   so the shares add up exactly). Tax then falls on the discounted base, which is how VAT and GST systems generally work.
4. Tax per line, with the rate the issuer typed in parts per million (`"8.875"` → 88,750): exclusive `round(net × ppm / 10⁶)`;
   inclusive `net = round(amount × 10⁶ / (10⁶ + ppm))`, `tax = amount − net`.
5. `total = Σnet + Σtax`; `amountDue = total − amountPaid`. Tax is broken down by rate for the summary block.

Bindings to add to `wrangler.toml` when wiring this up (create the bucket first, or the deploy fails):
```toml
browser = { binding = "BROWSER" }
[[r2_buckets]]
binding = "PFM_FILES"
bucket_name = "sawa-pfm-files"
```
Secrets: `PFM_KEK_v1` (32 random bytes, base64) and `PFM_LINK_KEY`. Switches (plain vars): `PFM_CARD=0`, `PFM_FX_QUOTES=0`.
Later: the card provider's API key and `PFM_PAY_WEBHOOK_SECRET` (decision 10), and `PFM_FX_URL` (decision 11). Dependency: `@cloudflare/puppeteer`. Browser Rendering is
available on the Workers Paid plan, which the account is on (C180). If it is unavailable, there is a fallback: the PWA opens the same HTML
(`inv.html` op) and calls `window.print()`. On Android and iOS the native share sheet then offers "Save as PDF".

---

## 7b. P1 as built (C263)

| Piece | Where | Notes |
|---|---|---|
| Ops | `pfm/pfm-worker.mjs` ← `worker-3.js` routes `pfm.*` (one line) and passes its Firestore helpers | `pfm.get` · `pfm.init` · `pfm.settings.set` · `pfm.cat.upsert` · `pfm.cat.archive` · `pfm.tx.add` · `pfm.tx.update` · `pfm.tx.delete` · `pfm.tx.list` · `pfm.summary` · `pfm.fx.last` · `pfm.audit.list` |
| One commit per change | row + month rollup increments + audit entry + audit head (updateTime precondition) | A lost race on the audit head re-reads and retries (up to 4 tries) |
| Idempotency | `pfm.tx.add` needs `idemKey`; the row id is `t_{idemKey}` | A repeated request returns the first result and writes nothing |
| Encryption | `note`, `counterparty` sealed with `PFM_KEK_v1` (AES-GCM, per-user HKDF key, uid as AAD) | Without the secret every op answers `pfm_not_configured` |
| Account deletion | purge job `pfm_{uid}` removes `pfm/{uid}/**` and `audit/{uid}/**` | |
| UI | `AccountantScreen` in `Sawa-app/app.p9.js`; entry card on the wallet home and first item in Wallet → Services | Onboarding, Overview (KPIs, daily cash flow, categories, 6-month net), Ledger (by day), add/edit/delete sheet, new category, typed FX rates |
| Tests | `node pfm/pfm-core.test.mjs` (26) · `node pfm/pfm-worker.test.mjs` (14, in-memory Firestore using the Worker's own value converters) · `node pfm/ui-check.mjs <Sawa-app> <react dir> <out>` (Chromium walkthrough, Arabic + English, light + dark) | |

P1 limits, on purpose:
- `baseCurrency` and `monthStartDay` can change only before the first entry (`locked_after_first_entry`). Re-basing history (§5.8) comes later.
- `pfm.tx.list` returns one budget month, up to 1,000 rows (`truncated: true` beyond that).
- `pfm.audit.list` shows and checks the latest 20 entries; a full-chain check is `verifyChain` over `audit/{uid}/log`.
- Kinds are `income` and `expense`. Transfers between own accounts, refunds and splits come with P2.

## 7c. P2 as built (C264)

| Piece | As built |
|---|---|
| Budgets | `pfm/{uid}/budgets/{categoryId \| _total}` `{ limit, currency (base), alertsBp }`: one budget per category, **every month** (no per-month copies). Status is computed on read from the month rollup (`pfm.budget.list`): spent, remaining, % used, linear pace, projection, state ok/warn/over |
| Alerts | After a write that touches an expense in the **current** budget month: for each touched budget (+ `_total`) the thresholds and pace alert are created as `pfm/{uid}/alerts/{month}_{cat}_{bp\|pace}` with `exists:false`. A threshold fires **once per month**, even when two writes race (tested with a forced race). Only the creator pushes, one push per budget (the most serious). Old months never alert. `pfm.alerts.list` / `pfm.alerts.read` |
| Recurring | `pfm/{uid}/recurring/{id}` `{ rule (monthly/weekly/yearly), nextDate, endDate, mode suggest\|auto, … }` (texts sealed). Due occurrences become `tx/r_{id}_{yyyymmdd}` (fixed ids ⇒ re-runs create nothing): `status: "suggested"` (outside rollups until `pfm.tx.confirm`; Skip = delete) or booked (`auto`). Catch-up is capped at 12; resuming a paused entry skips what was missed |
| Due index + cron | `pfmDue/{uid}.next` = earliest active next date. The `*/5` cron (paid: 40 users/run; free plan: 10, slot 2) runs `pfmCron`: range query `next <= today in UTC+14`, then each user's own time zone; creates the rows, one push "N entries to confirm". Opening the accountant (`pfm.get`) also catches up |
| Rules | `pfm/{uid}/rules/{id}` `{ contains (sealed), categoryId, kind }`. `pfm.tx.add` without `categoryId` uses them (`autoCategorized: true`); longest match wins; Arabic diacritics, tatweel and أ/إ/آ، ى، ة variants ignored. Same text again replaces the rule. The form picks the category live and offers “Always use … for …” |
| UI | Overview: budget-alert card (one line per budget, dismiss = read), “N recurring entries to confirm”, top-3 budget meters · Ledger: suggested rows (dashed, Confirm / Skip), Recurring (pause/resume/delete) and Rules sheets · Budgets tab: meters, over/left, pace, add/edit/delete with 50/80/100 % toggles · Entry form: rule hint, “Always use”, Repeat (monthly on day N / weekly on weekday / yearly) + “record automatically” |
| Tests | core 29 · worker 22 (budgets, single-fire alerts under a forced race, rules, recurring catch-up/confirm/skip/auto/pause, cron, purge) · `ui-check.mjs` P1 + P2 in Chromium |

P2 limits: budgets are in the base currency only and have no rollover yet; pushes in the foreground are not shown as an in-app toast (the Overview card shows them instead).

## 7d. P3 as built (C266)

| Piece | As built |
|---|---|
| Business details | `pfm/{uid}.biz` `{ name, contact, address 🔒, taxId 🔒, taxRegistered, taxLabel, taxRates[{id,label,rate}], defaultTaxRateId, invoicePrefix, defaultDueDays, defaultAllowPartial, defaultInvoiceCurrency, defaultPayoutAccountIds, lang }` · `pfm.biz.get/set`. `nextNumber` previews the coming number |
| Logo | **Changed from §5.7:** no R2 yet, so the logo is a ≤ 150 KB `data:` URI in `pfm/{uid}/files/logo` (as `photo.set` does for photos). The phone shrinks it to ≤ 512 px WebP; the server checks the bytes (`sniffLogo`) and that the declared type matches. Moving it to R2 later only changes `pfm.logo.set` and `inv.html` |
| Receiving accounts | `pfm/{uid}/payoutAccounts/{id}` (number 🔒, `numberLast4`), bank / mobile money / other; IBANs mod-97 checked; masked in lists; a changed number is audited and pushed to the owner; `sawa_wallet` refused until the wallet exists |
| Invoices | Top-level `invoices/{iv_…}` (client name/contact/tax ID 🔒, notes 🔒). Drafts: `inv.create/update` (rev), `inv.preview` (server totals while typing), `inv.delete`. `inv.send`: yearly number in one commit (`invoiceSeq.{year}` with updateTime precondition + `invoiceNumbers/{number}` exists:false — three simultaneous sends were tested to give 0001/0002/0003), issuer and accounts snapshot, `payLinks/{token}` for P4. `inv.cancel` (not after payments; revokes the link). `inv.list` (outstanding per currency, overdue count). `inv.get` |
| Payments | `inv.markPaid` (cash / bank transfer / mobile money / other; idempotency key = payment id; the issuer may record part of the amount whatever `allowPartial` says, since that setting governs payers). Same commit: payment doc, invoice totals/status, ledger income row `tx/i_…` in `c_invoices` (typed rate for a foreign currency, else waiting for one), rollups |
| PDF | **Changed from §5 / §7:** `inv.html` returns the rendered page; the app prints it through a hidden frame and the phone offers "Save as PDF". `invoice-pdf.mjs` (Browser Rendering → R2 → signed link) stays ready for when the bucket and binding exist |
| Share | The app shares (or copies) a text with number, amount due, due date, the chosen accounts and the reference line. The pay link joins this text in P4 |
| Overdue | `pfmCron` → `overdueSweep`: `status == "sent"` and due date before the issuer's local today → `overdue` (audited as `system:cron`) + one push. Overdue invoices can still be paid |
| UI | Invoices tab: "Clients owe you …" sentence, status filters, list · editor (client, currency, items with per-line tax menu only when tax-registered, whole-invoice discount, issue/due with presets, accounts, "pay in parts", notes, language, live server totals, save draft / send) · detail (status, amount left, items, payments, record payment, print/PDF, share, edit/send/delete draft, cancel) · business details (logo, identity, tax with self-typed rates, prefix with next-number preview, defaults, receiving accounts) |
| Tests | worker 33 (business, accounts, logo, drafts and tax policy, numbering incl. a forced 3-way race and the new-year reset, payments → ledger, cancel rules, foreign currency, printable page escaping, privacy between users, overdue cron, purge) · `ui-check.mjs` P1–P3 in Chromium, including the printed page |

P3 limits: no line-level discount in the editor (the server supports it); no refunds; the share text has no pay link until P4.

## 7e. P4 as built (C267)

| Piece | As built |
|---|---|
| Public endpoint | `POST {worker}/pfm/pay`, handled **before** the Authorization check in `worker-3.js`, with two operations only: `pay.view {token, lang?}` and `pay.claim`. The token (22 chars, ~113 bits) is looked up in `payLinks/`; the issuer is taken from the link, never from the request. Per-IP limits per Worker isolate: 60 views/min, 5 claims/10 min. Errors: `not_found` (404), `rate_limited` (429) |
| `pay.view` | Issuer name and logo, client name, number, dates, items, tax, total, paid, due, open-claims amount, `allowPartial`, the invoice's account snapshot (full numbers: the issuer chose to show them), the printable HTML. A cancelled link answers `status: "cancelled"`, `payable: false` |
| `pay.claim` | `invoices/{id}/payments/c_{idemKey}` with `state: "claimed"` (payer name/phone and reference 🔒), optional receipt photo in `invoices/{id}/proofs/{payId}` (≤ 400 KB, checked like the logo), `openClaims` / `claimedAmount` increments. Rules: invoice sent/overdue and link not revoked; account must be one on the invoice; amount ≤ due − already claimed; whole amount when `allowPartial` is off; ≤ 5 open claims. The invoice's updateTime guards the check (two full claims at once → one, tested). The issuer gets a push. **Nothing on the invoice changes until the issuer decides** |
| Issuer | `inv.claim.decide {decision: confirm\|reject, amount?, fxRate?, note?}`: confirm books exactly like a recorded payment (invoice totals/status, ledger income with the payer as counterparty); reject frees the room. `inv.claim.proof` returns the photo. `inv.link` returns the URL. `pfm.get.claimsCount` and `inv.list.claims` feed the UI |
| Pay page | `Sawa-app/pay.html` (standalone, no app, no login), served for `/pay/*` by `_redirects`; headers: no cache, `noindex`, `Referrer-Policy: no-referrer`. The API address is fixed in the page (a crafted link can't point it elsewhere). Arabic/English, light/dark, the app's font. One sentence leads ("You owe …"), then the accounts with copy buttons and the reference line, the items, the full invoice in a sandboxed frame (print/PDF), and the "Paid? Let … know" form (receipt photo shrunk on the device to ≤ 1280 px JPEG). The browser remembers its own report to show "Your report arrived" after a reload |
| App | "Needs you" shows reports to check; the invoices list marks invoices with a report; the detail shows each report (payer, amount, account, date, reference, phone, receipt) with **Not received** / **Received — confirm**; "Copy pay link"; the share text now ends with the link |
| Tests | worker 39 (view, bad/cancelled links, claim validation, idempotency, sealing, 5-claim cap, whole-amount rule, two full claims at once, proof checks, confirm with corrected amount, reject, per-IP limits) · `ui-check.mjs` P1–P4: the client opens the link in a fresh browser, sees the IBAN and amount, views the invoice, reports with a photo; the issuer sees it in "Needs you", opens the receipt, confirms; the link then shows "paid in full" (English, dark) |

P4 limits: the in-memory IP limiter is per isolate (best effort); a rejected report's note is stored but not shown to the client yet; the invoice card inside Sawa chat is not built (the link is shared as text).

## 7f. P5 as built (C269)

| Piece | As built |
|---|---|
| Receipt photos | `pfm.tx.receipt.set {id, data}` · `pfm.tx.receipt.get {id}` · `pfm.tx.receipt.delete {id}`. One photo per entry at `pfm/{uid}/files/r_{txId}`. **Changed from §2 (`attachmentKey` in R2):** no R2 yet, so the photo is a `data:` URI in Firestore, as with the logo. It is **sealed** like notes (a receipt can show card digits or an address). PNG/JPEG/WebP judged by the bytes (`sniffLogo`), declared type must match, ≤ 400 KB; sealed, the largest fits a Firestore document (< 1 MiB, tested). The row carries only `hasReceipt` (set with an updateMask and the row's updateTime; `buildTx` keeps it through edits and confirmations). Deleting the entry deletes the photo in the same commit. Audit: `tx.receipt.set` (sha, size), `tx.receipt.delete`. Account deletion already purges `files/` |
| CSV export | `pfm.export {from, to, lang?}` → `{filename, csv, rows, truncated}`. **Changed from §3 (signed R2 link):** the file comes back in the response and the app saves it (`saveFileOut`: Android bridge, iOS share sheet, browser download). Budget months `from..to`, ≤ 24 (`range_too_long`), ≤ 5,000 rows (`truncated`). Booked rows only: suggested and deleted rows are left out. Columns: date, type, category, amount and currency, amount in the base currency, rate (both empty while the rate is pending), payee, note, receipt. Arabic or English headers. UTF-8 with a BOM (Excel reads Arabic), CRLF, RFC 4180 quoting; text cells starting with `= + - @` get a leading apostrophe so a spreadsheet doesn't run them |
| App | Entry form: «صورة الإيصال» — pick a photo, shrunk on the phone to ≤ 1280 px JPEG on white (quality stepped down to fit 400 KB), uploaded after the entry is saved; view, replace, remove. Ledger rows with a photo show a clip. Ledger → «تصدير»: this month / last 3 / last 12 months or any range, then «تنزيل CSV» |
| Fixed on the way | `sealField` built its base64 with `String.fromCharCode(...bytes)`, which overflows the call stack on a large input (a 400 KB photo did); it now works in chunks |
| Currencies | KWD and JPY added (decision 8 now lists twelve) |
| Tests | core 29 · worker 42 (receipts: sealing, edits keep the flag, replace/remove, delete with the entry, type and size checks, other users; export: booked rows only, order, quoting, formula defusing, pending rate, both languages, range limits) · `ui-check.mjs` P1–P5: a 1600×1200 PNG becomes a ≤ 1280 px JPEG, the clip shows, the photo opens, the CSV downloads with the right header and rows |

## 8. Delivery plan

| Phase | Scope | Exit check |
|---|---|---|
| **P1** ✅ C263 | Onboarding (base currency, time zone), categories, manual ledger in any currency with user-typed rates, rollups, Overview and Ledger tabs, audit chain | Rollup rebuild = live rollup on test accounts; a USD, a JPY and a KWD entry sum correctly in a SAR base |
| **P2** ✅ C264 | Budgets and alerts, recurring entries, categorisation rules | The 80 % alert fires once; a recurring entry is suggested, not booked, until confirmed |
| **P3** ✅ C266 | Invoices: business settings (logo, tax toggle, receiving accounts, prefix), editor, send with yearly numbering, PDF, share, record payment (cash/transfer), overdue cron | Totals match between the editor, the PDF and the stored invoice; two sends at once get consecutive numbers; the first invoice in January is `-0001` |
| **P4** ✅ C267 | `/pay/{token}`: payment details, "I've paid" transfer claims and issuer confirmation, partial payments, invoice card in chat | A concurrent double tap → one payment; an underfunded wallet → clear error, nothing written; a claim changes nothing until confirmed |
| **P5** ✅ C269 | CSV export, receipt photos | A receipt is sealed at rest, survives edits and goes with its entry; the export holds only booked rows, in date order, with formula-like text defused |
| *Later* | **Wallet** (decision 13): server-side wallet ledger with one balance per currency (§2.6), auto-sync (§5.1), wallet payment (§5.2). **Cards** (decision 10): provider, bank-account onboarding, checkout, webhook, payout to the issuer's bank, auto-refund on overpayment. **FX** (decision 11): reference-rate feed, wallet conversion with quotes and the chosen margin | Cards: a duplicate webhook → one payment; two full payments at once → one paid, one refunded. FX: a quote can be used once, and an expired one is refused |

Answered 2026-11-05: see §0.

Answered 2026-11-06: card provider not for now (decision 10), FX source and margin later (decision 11), card money straight to the
issuer's bank (decision 12).

Answered 2026-11-06: no server-side wallet balance for now (decision 13).

P1–P5 are built. The *Later* row needs three decisions: building the wallet ledger, the card provider, and the FX source and margin.
