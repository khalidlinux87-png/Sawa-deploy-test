# Sawa Wallet: Personal Accountant & Invoicing (PFM) design

Status: proposal, rev 2 (product decisions applied, §0) · Date: 2026-11-05 · Code: `pfm/` (pure logic and tests, not wired into `worker-3.js` yet)

This design follows how Sawa is already built:

| Layer | What already exists | What PFM adds |
|---|---|---|
| Client | PWA (`Sawa-app`, React, `app.p1…p9.js`), with Android and iOS shells | An "Accountant" tab with ledger, dashboard, budgets and invoices, plus a public `/pay/{token}` page |
| API | Cloudflare Worker `worker-3.js`: `POST /api {op, …}`, Firebase ID token, `fsCommit` | `pfm.*` and `inv.*` ops, `GET /pfm/file` (signed PDF download), and a cron step |
| Data | Firestore (REST, service account `SA_JSON`). Client rules deny writes to server-owned data | New collections, below. The client can **read** its own data. **Every write goes through the Worker** |
| Files | — | R2 bucket `sawa-pfm-files` (PDFs) and Cloudflare Browser Rendering (HTML to PDF) |
| Push | FCM / APNs (`fcmSend`) | Budget alerts, invoice paid, invoice overdue, bank-transfer claims |
| Payments | Wallet only (client mock) | Card checkout through a payment provider (guest payers too), plus the issuer's own bank and mobile-money accounts printed on the invoice |

> **Blocker, and first piece of work.** The current Sawa Wallet is **client-side state** (`app.p8.js`: `useState(45200)`).
> Auto-sync (§5.1) and one-tap settlement (§5.2) need a **server-side wallet ledger**, so a balance changes only inside a Worker commit.
> §2.6 sets out the smallest wallet contract this design needs. Ship that first, behind a flag. Without it, PFM can still ship
> manual entry, budgets and invoices (paid by marking them paid by hand).

---

## 0. Product decisions (2026-11-05)

| # | Decision | Where it lands |
|---|---|---|
| 1 | **Tax registration is a per-user setting.** When it is off, the editor hides every tax field and the server refuses tax (`tax_not_registered`) | §2.1 `taxRegistered`, `applyTaxPolicy()`, §4.3 |
| 2 | **Invoice numbers reset every year:** `INV-2026-0001`, `INV-2026-0002`, … then `INV-2027-0001`. The year is the issue date's year in the issuer's time zone | §2.1 `invoiceSeq`, §5.6, `invoiceNumber()` |
| 3 | **Partial payments are allowed by default.** The issuer can turn them off per invoice (`allowPartial: false`) | §2.7, `applyPayment()` |
| 4 | **Clients without a Sawa account can pay by card** on `/pay/{token}` as guests, with no sign-up | §5.4, `inv.checkout`, webhook |
| 5 | **The issuer can add a logo**, printed on the PDF, the pay page and the invoice card in chat | §2.1 `logoKey`, §5.7, `sniffLogo()` |
| 6 | **The issuer can save accounts for receiving money:** Sawa Wallet, bank accounts and mobile money (e.g. Bankak). Each invoice prints the ones the issuer picks. A payer who transfers can report it, and the issuer confirms it | §2.9, §5.5, `validatePayoutAccount()` |

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
2. **Integer minor units everywhere** (`amount: 123450` = 1,234.50 SDG), with a `currency` on every money-bearing document.
   Rates are in basis points (`1500` = 15 %). Quantities are decimal strings with up to 3 places. No floats.
3. **Precomputed monthly rollups** (`pfm/{uid}/months/{YYYY-MM}`) are updated in the same commit as each transaction with
   Firestore `increment` transforms. The dashboard and budget meters read one document instead of scanning the ledger.
4. **Idempotent by design.** A wallet sync writes `tx/w_{walletTxId}`, and a payment writes `payments/{idemKey}` with
   `exists:false`, so a retry or a duplicate event cannot double-count. This matches `gfetch`, which already refuses to retry
   commits that carry preconditions or increments.
5. **Single currency per ledger view.** Each user has a `baseCurrency` (default SDG). A transaction in another currency stores
   `amount` and `currency` as they happened, plus `baseAmount` at a recorded `fxRate`. Rollups and budgets use `baseAmount`.

---

## 2. Data model (Firestore)

Paths are relative to `DOC_ROOT`. 🔒 = encrypted field (AES-256-GCM, one key per user, see §6). ⚙ = written only by the server.

### 2.1 `pfm/{uid}` — settings
```ts
{ baseCurrency: "SDG", tz: "Africa/Khartoum", monthStartDay: 1,      // a budget month can start on payday
  taxRegistered: false,                                               // decision 1: off ⇒ no tax fields, server refuses tax
  defaultTaxBp: 1700,                                                 // used only when taxRegistered
  invoicePrefix: "INV",                                               // A–Z/0–9, up to 8 characters
  invoiceSeq: { "2026": 42 } ⚙,                                       // decision 2: one counter per year, a new year starts at 1
  defaultDueDays: 14, defaultAllowPartial: true,                      // decision 3
  defaultPayoutAccountIds: ["pa_wallet", "pa_3f…"],                   // decision 6: pre-selected on new invoices
  issuerProfile: { name, contact, address 🔒, taxId 🔒,
                   logoKey: "logos/{uid}/{sha256}.png" ⚙ },          // decision 5; pre-fills new invoices
  autoSync: { enabled: true, since: Timestamp },
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
  currency: "SDG", baseAmount: 2500, fxRate: "1",
  categoryId: "c_telecom",
  occurredAt: Timestamp, month: "2026-11",    // month: the budget month (honours monthStartDay)
  note: 🔒 string, counterparty: 🔒 string,
  source: "manual" | "wallet" | "invoice" | "import",
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
  limit: 100000, currency: "SDG",
  rollover: false,                            // carry unspent (or overspent) into next month
  carriedIn: 0 ⚙,
  alertsBp: [5000, 8000, 10000], firedBp: [5000] ⚙,      // -1 = the pace alert has fired
  recurring: true }                           // the cron copies it into the next period on day 1
```
Spending for a budget = `months/{period}.cat[catId].e` (refunds already netted out). No separate counter to drift.

### 2.6 Wallet ledger (prerequisite)
```ts
wallets/{uid}            { balance ⚙, currency, status: "active" | "frozen", pinHash ⚙, updatedAt ⚙ }
wallets/{uid}/tx/{wtxId} { type: "transfer.in" | "transfer.out" | "purchase" | "bill" | "topup" | "withdraw" | "refund"
                                 | "fee" | "invoice.paid" | "invoice.received",
                           amount (signed), currency, balanceAfter, counterpartyUid?, counterpartyName?, mcc?,
                           invoiceId?, refundOf?, at, idemKey }
```
Any Worker op that changes `wallets/{uid}.balance` also writes the matching `pfm/{uid}/tx/w_{wtxId}` **in the same commit**
(§5.1). The sync cannot lag or drop a row.

### 2.7 `invoices/{invoiceId}` — top-level, so the payer can be resolved without the issuer's path
```ts
{ issuerUid, number: "INV-2026-0042",        // assigned at send time; unique per issuer (guarded by invoiceNumbers/, §5.6)
  status: "draft" | "sent" | "paid" | "overdue" | "cancelled",
  lang: "ar" | "en", currency: "SDG",
  issueDate: "2026-11-05", dueDate: "2026-11-19",   // dates in the issuer's time zone
  issuer: { name, contact, address 🔒, taxId 🔒, logoKey },   // snapshot, so later profile edits don't rewrite old invoices
  payoutAccounts: [{ id, type, label, holderName, bankName?, provider?, number 🔒, branch?, details? }],  // snapshot of the chosen accounts
  allowPartial: true,                         // decision 3; the issuer can switch it off before sending
  client: { name, contact, email?, phone?, taxId 🔒, sawaUid? },
  items: [{ description, qty: "2.5", unitPrice, discount?: {type:"pct",bp} | {type:"amt",minor}, taxBp }],  // ≤ 200
  invoiceDiscount?: {…}, taxInclusive: false, notes,
  totals ⚙: { subtotal, invoiceDiscount, netTotal, taxTotal, total, taxBreakdown[], amountPaid, amountDue },
  payLinkToken ⚙, sentAt ⚙, paidAt ⚙, cancelledAt ⚙, cancelReason,
  pdf ⚙: { key, hash, renderedAt },
  rev ⚙, createdAt ⚙, updatedAt ⚙ }
```
- Only `draft` invoices can be edited. Once `sent`, the content is frozen. A fix means cancel and reissue, the way accountants do it.
- Tax fields (`taxBp`, `taxInclusive`) must be 0/false unless the issuer's `taxRegistered` is on (`applyTaxPolicy`).
- `invoices/{id}/payments/{payId}` ⚙
  ```ts
  { amount, currency, at,
    method: "wallet" | "card" | "bank_transfer" | "mobile_money" | "cash" | "manual",
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
  bankName?: "Bank of Khartoum", branch?: "Khartoum 2",
  provider?: "Bankak (mBOK)",                 // mobile money
  number 🔒: "1234567890123",                  // account number, IBAN (mod-97 checked) or phone number
  numberLast4: "0123",                        // in clear, for lists: "•••• 0123"
  details?: "…",                              // "other": free text, ≤ 200 characters
  currency: "SDG", isDefault: true, archived: false, createdAt ⚙, updatedAt ⚙ }
```
- `pa_wallet` (type `sawa_wallet`) always exists and cannot be deleted. It is what makes the in-app "Pay" button and card checkout work.
- Up to 10 accounts. Changing an account never changes invoices already sent: they keep their own snapshot.
- A full account number appears only in the issuer's own editor, the PDF and the pay page of an invoice that lists it. Lists show `numberLast4` only.

### 2.10 `audit/{uid}/log/{seq}` ⚙ — append-only, hash-chained
```ts
{ seq: 1042, prevHash, hash,                  // hash = SHA-256(prevHash | canonical(entry))
  at, actor: uid | "system:wallet" | "system:cron", ip?: hashed,
  action: "tx.add" | "tx.update" | "tx.delete" | "budget.set" | "invoice.create" | "invoice.status" | "invoice.payment" | …,
  ref: "tx/t_…" | "invoices/…", before?: {changed fields}, after?: {changed fields} }   // 🔒 fields stay encrypted in here too
```
`audit/{uid}` holds `{ headSeq, headHash }`. Each audit write sets `currentDocument.updateTime` on it, so two concurrent writes
cannot fork the chain: one fails and retries. See §6.3 for anchoring.

### 2.11 Security rules (added to `firestore.paste.rules`)
```
match /pfm/{uid}/{doc=**}      { allow read: if request.auth.uid == uid; allow write: if false; }
match /invoices/{id}           { allow read: if request.auth.uid == resource.data.issuerUid
                                             || request.auth.uid == resource.data.client.sawaUid; allow write: if false; }
match /invoices/{id}/payments/{p} { allow read: if request.auth.uid == get(/databases/$(database)/documents/invoices/$(id)).data.issuerUid; allow write: if false; }
match /payLinks/{t}            { allow read, write: if false; }   // resolved only through the Worker
// pfm/{uid}/payoutAccounts and invoiceNumbers are covered by the pfm rule above (owner reads, nobody writes)
match /audit/{uid}/{doc=**}    { allow read: if request.auth.uid == uid; allow write: if false; }
match /wallets/{uid}/{doc=**}  { allow read: if request.auth.uid == uid; allow write: if false; }
```

---

## 3. API

House convention: `POST /api` with `Authorization: Bearer <Firebase ID token>` and a body of `{ op, ...payload }`. The response is
`{ ok: true, ... }` or `{ ok: false, code, msg }`. The REST column is the equivalent path if these are ever exposed as REST. Every
mutating op accepts `idemKey` (a client UUID), which is kept in `pfm/{uid}/idem/{key}` for 24 hours. A repeat returns the first response.

### 3.1 Ledger, categories, budgets, analytics

| op | REST | Payload → result |
|---|---|---|
| `pfm.tx.add` | `POST /v1/pfm/tx` | `{kind, amount: "1,250.50", currency?, categoryId, occurredAt, note?, counterparty?, tags?}` → `{tx}` |
| `pfm.tx.update` | `PATCH /v1/pfm/tx/{id}` | `{id, rev, …changed}` → `{tx}`. `409 stale` if `rev` doesn't match. Wallet rows: only `categoryId`, `note`, `tags` |
| `pfm.tx.delete` | `DELETE /v1/pfm/tx/{id}` | `{id, rev}` → soft delete. Wallet and invoice rows can't be deleted, only hidden |
| `pfm.tx.list` | `GET /v1/pfm/tx?month=&cat=&q=&cursor=` | → `{items, cursor}`, 50 per page. Decrypts 🔒 fields for the caller |
| `pfm.tx.split` | `POST /v1/pfm/tx/{id}/split` | `{id, parts:[{amount, categoryId}]}`. The parts must add up to the total |
| `pfm.cat.upsert` / `pfm.cat.archive` | `PUT/DELETE /v1/pfm/categories/{id}` | |
| `pfm.rule.upsert` | `PUT /v1/pfm/rules/{id}` | `{match:{type?, counterpartyUid?, contains?, mcc?}, categoryId, applyToPast?: bool}` |
| `pfm.budget.set` | `PUT /v1/pfm/budgets/{period}/{cat}` | `{period, categoryId, limit, rollover?, recurring?, alertsBp?}` |
| `pfm.summary` | `GET /v1/pfm/summary?from=2026-06&to=2026-11` | → `{months:[{month, income, expense, net, savingsRateBp}], byCategory, budgets:[budgetStatus…]}` |
| `pfm.export` | `GET /v1/pfm/export?from&to&format=csv` | Signed R2 link to a CSV file |
| `pfm.settings.set` | `PATCH /v1/pfm/settings` | `{taxRegistered?, defaultTaxBp?, invoicePrefix?, defaultDueDays?, defaultAllowPartial?, issuerProfile?}`. Turning `taxRegistered` off does not touch invoices already sent |
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
| `inv.public` | `GET /v1/pay/{token}` | **No auth.** → `{number, issuer:{name, logoUrl}, total, amountDue, currency, dueDate, status, items, allowPartial, payoutAccounts, methods:["wallet","card","transfer"]}`. Hides the issuer's contact and address; shows the tax ID only if the invoice includes tax. Rate-limited per IP |
| `inv.pay` | `POST /v1/pay/{token}` | Auth required (Sawa user). `{token, amount?, method:"wallet", pin, idemKey}` → `{status, amountDue, receiptTxId}`. §5.2 |
| `inv.checkout` | `POST /v1/pay/{token}/checkout` | **No auth needed** (decision 4). `{token, amount?, payer:{name, email?, phone?}, idemKey, captcha}` → `{checkoutUrl}` or `{clientSecret}` from the card provider. §5.4 |
| `inv.claim` | `POST /v1/pay/{token}/claim` | Auth optional. "I've paid by transfer": `{token, amount, payoutAccountId, reference, proof? (image), payer:{name, phone?}}` → `{payId, state:"claimed"}`. §5.5 |
| — | `POST /pfm/webhook/{provider}` | Card provider webhook. Signature checked against `PFM_PAY_WEBHOOK_SECRET`; the payment is looked up by the provider's intent ID, never by data in the body alone |

`inv.send` example response:
```json
{ "ok": true, "number": "INV-2026-0042", "status": "sent",
  "payUrl": "https://www.sawaaap.com/pay/9fK2xQ…", "pdfUrl": "https://…/pfm/file?k=…&e=…&s=…",
  "shareText": "فاتورة INV-2026-0042 من خالد للتصميم بمبلغ 580,000.00 ج.س — ادفع عبر سوا: https://www.sawaaap.com/pay/9fK2xQ…" }
```

Error codes: `bad_amount`, `too_precise`, `bad_currency`, `bad_items`, `bad_transition`, `not_payable`, `overpay`,
`insufficient_funds`, `bad_pin`, `pin_locked`, `stale` (409), `rate_limited` (429), `self_pay`,
`partial_not_allowed`, `tax_not_registered`, `bad_account`, `bad_logo`, `card_unavailable`, `claim_pending`.

---

## 4. UI/UX

### 4.1 Navigation
`Wallet` tab → segmented control **Wallet | Accountant**. The Accountant has 4 sub-tabs: **Overview · Ledger · Budgets · Invoices**,
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
│  ├─ SearchBar + FilterChips (category, source: wallet/manual/invoice, type)
│  ├─ SyncBanner           "Wallet sync on · 3 new transactions categorised" → review
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
   ├─ TaxToggle            "I am registered for VAT" → shows the default rate and tax ID; off hides all tax fields
   ├─ Numbering            prefix + preview "INV-2026-0043 (resets every January)"
   └─ ReceivingAccounts    list: Sawa Wallet (fixed) · Bank of Khartoum •••• 0123 · Bankak •••• 5678 · ＋ Add account
PublicPayPage (/pay/{token})   logo + invoice → Pay with Sawa Wallet | Pay by card (no account needed) | I paid by transfer
```

### 4.3 Invoice editor
One scrolling form with a sticky **totals bar** at the bottom: `Total 580,000.00 ج.س ▴`. Tap it to expand the full breakdown.
1. **Client:** search Sawa contacts (sets `client.sawaUid`, enabling in-app delivery and one-tap pay), or enter one by hand. Recent clients come first.
2. **Items:** rows with description, qty, unit price, then "＋ discount" and the tax rate chip (default from settings). The tax chip and the "prices include tax" toggle **appear only when the user is tax-registered**. Otherwise a one-line hint links to the setting. Swipe to delete, drag to reorder. Saved items can be reused.
3. **Terms:** issue date, due date (presets: on receipt / 7 / 14 / 30 days), invoice discount, prices include tax (registered users only), "Allow partial payments" (on by default), notes.
4. **Get paid by:** chips for the saved receiving accounts, with the defaults pre-selected. Sawa Wallet / card is always on. "＋ Add account" opens the account form without leaving the editor.
5. **Actions:** `Save draft` · `Preview PDF` · **`Send`** → share sheet: WhatsApp / Telegram (text + link), Email (PDF attached), Copy link, Sawa chat (an invoice card in the conversation).

The header shows the logo and the number the invoice will get (`INV-2026-0043`, final once sent).
Totals come from `inv.preview` (debounced). While a request is in flight, the bar shows the last server result with a subtle spinner.
The client never shows totals computed in the browser, so what the user sees always matches the PDF. Validation is inline: an
amount with too many decimals is flagged at the field.

### 4.4 Auto-sync flow (what the user sees)
1. First open: "Track wallet activity automatically?" → On (default) or Off. The choice is in settings.
2. Each wallet payment appears in the Ledger immediately, marked ⚡, with a category from the user's rules or a default.
3. The SyncBanner counts rows in `c_uncategorized`. "Review" shows a one-by-one card stack: pick a category, with an "always for this payee" checkbox.
4. Budget alerts arrive as push messages: "Food: 82 % used, 18,000 ج.س left, 15 days to go".

### 4.5 Paying an invoice (payer)
The pay page and the chat card show the issuer's logo, name, the amount due and three choices:
- **Sawa Wallet** (signed in): **Pay 480,000.00 ج.س** → bottom sheet with the balance → PIN pad (the existing 6-digit wallet PIN) → receipt.
  With too little balance it offers "Top up" or "Pay by card".
- **Card, no account needed** (decision 4): name and email or phone for the receipt → the provider's hosted card form → back to
  `/pay/{token}?done=1`, which waits for the webhook result (polling `inv.public` every 2 s, up to 60 s) → receipt by email or SMS.
  Afterwards a "Create a Sawa account to keep your receipts" offer (optional).
- **Bank or mobile money:** the issuer's chosen accounts, each with a copy button for the number, plus the invoice number to use as
  the payment reference → after transferring, **"I've paid"** → amount, reference, optional screenshot → "Sent to the issuer for confirmation".

**Amount field:** shows the full amount due. When partial payments are allowed (the default) the payer can lower it. Otherwise the field is locked.
Both parties get a push; the issuer's invoice updates live through `onSnapshot`: **partly paid · 100,000 of 580,000**, then **Paid**.

---

## 5. Key flows

### 5.1 Wallet → ledger auto-sync (same commit)
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

### 5.2 One-tap settlement `inv.pay`
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
    if (payer.currency !== inv.currency) throw new PfmError("currency_mismatch"); // FX payment: phase 2
    if (payer.balance < amount) throw new PfmError("insufficient_funds");

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
After the commit: push to the issuer ("INV-2026-0042 paid: 480,000.00 ج.س"), and in `waitUntil` re-render the PDF with the **PAID** badge.

### 5.3 Shared payment commit
§5.2 (wallet), §5.4 (card webhook), §5.5 (confirmed transfer) and `inv.markPaid` all end in one function,
`commitInvoicePayment(inv, payment)`. It uses `applyPayment()` (which enforces `allowPartial` and refuses overpayment) and writes
the payment record, the invoice totals and status, the issuer's ledger income row (`i_{invoiceId}_{payId}`, category `c_invoices`) and the audit entries.
Only the wallet path also moves wallet balances. One code path keeps the four methods consistent.

### 5.4 Card payment by a guest (decision 4)
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
- Payout to the issuer: the card money is credited to the issuer's **Sawa Wallet** (minus the provider fee, shown as a separate
  `fee` ledger row), so it then follows the wallet's normal withdrawal rules.
- **Provider:** not chosen yet (§8). The code goes behind a small interface, `createIntent / verifyWebhook / refund`, so the
  provider can change without touching invoice logic. Card acceptance for Sudanese-pound cards depends on the provider and on local
  regulation. Until a provider is live, `methods` simply omits `card` and the page shows wallet and transfer options only (`card_unavailable`).

### 5.5 Bank and mobile-money transfers (decision 6)
Money sent straight to the issuer's bank or Bankak never passes through Sawa, so Sawa cannot see it arrive. The flow is therefore
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

### 5.8 Cron (adds to the existing `*/5` schedule, at a cheap cadence)
- **Overdue sweep** (hourly slot): query `invoices where status == "sent" and dueDate < today(issuer tz)` → `overdue` + audit + push. Reminders are sent 3 days before and on the due date (opt-in).
- **Recurring budgets** (on the 1st, per user time zone): copy `recurring: true` budgets into the new period, adding `carriedIn` for rollover.
- **Audit anchor** (daily): see §6.3.
- **Stale card payments** (hourly): `pending` payments older than 24 h → `failed` (after checking the provider's status).

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
- The wallet PIN is required for every wallet payment, with a server-side hash, attempt counter and lockout.
- The pay page shows the issuer's **verified** name and a warning when the issuer account is under 7 days old.
- Guest checkout: captcha, 5 checkouts per invoice per hour, 20 per IP per day, and the amount must be ≤ the amount due. The provider's own fraud checks (3-D Secure) are required.
- Transfer claims: 5 open claims per invoice; proof images go through the same check as logos.
- Receiving accounts: changing an account's number sends a push and an email to the owner ("Your Bank of Khartoum account details were changed") and is logged. That gives a hijacked account little time to redirect payments unnoticed. Invoices already sent keep their original account snapshot.
- Every display path escapes HTML (the template uses `esc()`). The PDF renderer runs with JavaScript off and all network requests blocked.

---

## 7. Code in this folder

| File | What it is | Status |
|---|---|---|
| `pfm-core.mjs` | Money parsing (including Arabic-Indic digits), `computeInvoice` (line and invoice discounts, exclusive or inclusive tax, tax per rate), `allocate`, status machine, `applyPayment` (with `allowPartial`), `invoiceNumber` / `localDate` (yearly numbering), `applyTaxPolicy`, `validatePayoutAccount` (with IBAN check) / `maskNumber`, `sniffLogo`, `budgetStatus` (thresholds, variance, pace), `summarize`, `walletEventToTx`, audit hash chain, field encryption | Tested: `node pfm/pfm-core.test.mjs` (17 tests) |
| `invoice-html.mjs` | Self-contained invoice template, Arabic RTL and English: logo, pay QR block, receiving accounts | Rendered to PDF with Chromium in both languages (`samples/`) |
| `invoice-pdf.mjs` | Worker pipeline: recompute totals → HTML → hash → R2 cache → Browser Rendering → signed link, and `serveSignedFile` | Not deployed: needs the bindings below |

How `computeInvoice` handles tax (the rule the code and tests enforce):
1. `gross = round(qty × unitPrice)` per line (BigInt, half away from zero).
2. Line discount (percentage or fixed amount, capped at gross) → **row amount** (shown on the invoice).
3. The invoice discount is computed on the sum of row amounts and **spread over lines in proportion** (largest remainder,
   so the shares add up exactly). Tax then falls on the discounted base, which is what VAT authorities require.
4. Tax per line: exclusive `round(net × bp / 10000)`; inclusive `net = round(amount × 10000 / (10000 + bp))`, `tax = amount − net`.
5. `total = Σnet + Σtax`; `amountDue = total − amountPaid`. Tax is broken down by rate for the summary block.

Bindings to add to `wrangler.toml` when wiring this up (create the bucket first, or the deploy fails):
```toml
browser = { binding = "BROWSER" }
[[r2_buckets]]
binding = "PFM_FILES"
bucket_name = "sawa-pfm-files"
```
Secrets: `PFM_KEK_v1` (32 random bytes, base64), `PFM_LINK_KEY`, and later the card provider's API key and `PFM_PAY_WEBHOOK_SECRET`. Dependency: `@cloudflare/puppeteer`. Browser Rendering is
available on the Workers Paid plan, which the account is on (C180). If it is unavailable, there is a fallback: the PWA opens the same HTML
(`inv.html` op) and calls `window.print()`. On Android and iOS the native share sheet then offers "Save as PDF".

---

## 8. Delivery plan

| Phase | Scope | Exit check |
|---|---|---|
| **P0** | Server-side wallet ledger (§2.6), behind a flag. The PWA reads its balance from `wallets/{uid}` | Balance is equal on 2 devices; replaying the same request does not double-charge |
| **P1** | Categories, manual ledger, rollups, Overview and Ledger tabs, audit chain | Rollup rebuild = live rollup on test accounts |
| **P2** | Budgets and alerts, auto-sync from wallet, rules | A wallet purchase appears in the Ledger within one commit; the 80 % alert fires once |
| **P3** | Invoices: business settings (logo, tax toggle, receiving accounts, prefix), editor, send with yearly numbering, PDF, share, record payment (cash/transfer), overdue cron | Totals match between the editor, the PDF and the stored invoice; two sends at once get consecutive numbers; the first invoice in January is `-0001` |
| **P4** | `/pay/{token}`: wallet payment (`inv.pay`), partial payments, "I've paid" transfer claims and issuer confirmation, invoice card in chat | A concurrent double tap → one payment; an underfunded wallet → clear error, nothing written; a claim changes nothing until confirmed |
| **P5** | Guest card checkout through the chosen provider, webhook, auto-refund on overpayment | A duplicate webhook → one payment; two full card payments at once → one paid, one refunded |
| **P6** | CSV export, receipt photos, multi-currency FX | — |

Answered 2026-11-05: see §0.

Still open:
1. **Card provider:** which provider can accept cards for Sudanese issuers, and in which currencies (SDG, USD)? The answer fixes the fee model and whether card payments must settle in a currency other than the invoice's.
2. **Payout of card money:** is crediting the issuer's Sawa Wallet (§5.4) acceptable, or must it go straight to their bank account?
3. **E-invoicing:** are formats such as ZATCA (Saudi Arabia) in scope for issuers abroad, or only Sudan's 17 % VAT?
