# Sawa Wallet Engine: bulk receipt and payment-message import (P6) design

Status: rev 1 · **design only, not built** · Date: 2026-11-08 · Extends `DESIGN.md` (PFM rev 9, P1–P5 built)

**What it does.** The user hands the Personal Accountant a batch: photos of receipts, PDF invoices or statements, or
pasted payment messages (SMS or email). Sawa reads every transaction in it, fills in the fields below, files each one
under a category and a **project**, and shows a review table. Nothing is booked until the user confirms. Every imported
entry can then be searched by any of seven fields.

**What it reuses.** The ledger (`pfm/{uid}/tx`), *suggested* rows and `pfm.tx.confirm` (P2), categorisation rules
(`matchCategoryRule`), sealed fields (`sealField`), receipt photos (P5), money in integer minor units, the twelve currencies
(decision 8), the audit chain, and `idemKey`. The Worker stays the only writer.

---

## 0. Decisions needed before building

| # | Question | Proposal |
|---|---|---|
| I1 | Which service reads the images and text? | A Claude vision model through the Anthropic API, called **only from the Worker** (`ANTHROPIC_API_KEY` as a Worker secret, never in the app). The model name is a Worker variable (`IMPORT_MODEL`), so it can change without a release. Text messages first go through the local parsers (§4.2), which cost nothing |
| I2 | Cost limit | 200 items per user per day, 50 per batch; admin can raise it. Kill switch `PFM_IMPORT=0` |
| I3 | Consent | Receipts leave Sawa's own servers for the AI provider. A one-time consent screen before the first import, a line in `privacy.html`, and an account on the provider's no-training / short-retention terms. Without consent the import button stays off |
| I4 | Projects vs tags | **Projects are a new field** (one per entry, default "General"); tags stay free-form and many per entry. A project is the "ledger context" from the brief: a shop, a building job, a family event |
| I5 | Reading SMS automatically on Android | **No.** Google Play restricts the SMS permission to default SMS apps. The user pastes or *shares* messages to Sawa (Android share target, iOS share sheet) |

---

## 1. Field mapping

The brief's nine fields, and where each one lives. 🔒 = sealed (AES-256-GCM, per-user key, `DESIGN.md` §6.2).

| Brief field | Arabic | Stored as | Notes |
|---|---|---|---|
| `transaction_id` | رقم العمليّة | `ref` 🔒 + `refIx` (blind index, §5) | The provider's reference. Also the duplicate check (§4.5). Missing or unreadable ⇒ flagged |
| `timestamp` | التاريخ والوقت | `occurredAt` (Timestamp) + `month` | Read in the user's time zone (`pfm/{uid}.tz`) unless the source states one. Shown and exported as `YYYY-MM-DD HH:MM:SS`. Date with no time ⇒ `00:00:00` and `timeKnown: false` |
| `sender` | المرسل | `sender` 🔒 | Name, phone or entity. New field (today there is one `counterparty`) |
| `recipient` | المستقبل | `recipient` 🔒 | Same. `counterparty` is set to whichever side is **not** the user, so the ledger, rules and CSV keep working |
| `amount` | القيمة الماليّة | `amount` (minor units) + `currency` | Parsed with `toMinor()`. A currency outside the twelve ⇒ flagged `bad_currency`, never guessed |
| `service_type` | نوع الخدمة | `serviceType` (enum, §1.1) | In clear, so it can be filtered and counted |
| `project_name` | اسم المشروع | `projectId` → `pfm/{uid}/projects/{id}` | Default: the project picked for the batch, else `p_general` («عامّ») |
| `category` | التصنيف العامّ | `categoryId` | The user's rules first, then the model's suggestion from the user's own category list, else `c_uncategorized` |
| `raw_source_type` | نوع المصدر | `importSource` | `image_ocr` · `pdf_document` · `sms_notification` · `email_forward` |

Also on each imported row: `source: "import"`, `importId`, `status: "suggested"`, `verify: [field…]` (§4.4),
`confidence` per field, and `hasReceipt` (the photo or PDF page is kept as the entry's receipt, P5).

**Direction.** `kind` comes from who the user is: user = recipient ⇒ `income`; user = sender ⇒ `expense`; both are the
user's own accounts ⇒ `transfer`. The user's names, phone numbers and masked account numbers (from the profile and
`payoutAccounts`) are given to the matcher, not guessed by the model. Unknown ⇒ flagged `kind`.

### 1.1 `serviceType` values

`utility` (electricity, water) · `telecom` (airtime, data) · `commercial_supply` · `retail` · `logistics` · `remittance`
(person-to-person transfer) · `bank_transfer` · `salary` · `rent` · `government_fee` · `education` · `health` · `fuel` ·
`subscription` · `cash` · `other`.

Stored as these English codes; the app shows the Arabic or English label. Adding a value is safe; removing one is not.

### 1.2 `pfm/{uid}/projects/{id}` (new)

```ts
{ name: 🔒 string, color: "#0f766e", archived: false, order: 2,
  createdAt ⚙, updatedAt ⚙ }
```
`p_general` is created on first use and cannot be deleted. Archiving a project hides it from pickers; its entries keep it.
Rollups gain `proj.{projectId}.e|i|n` in `months/{YYYY-MM}`, so a per-project total is one read, like categories.

---

## 2. Architecture

```
 App (Accountant → «استيراد»)                       Worker
 ─────────────────────────────                      ─────────────────────────────────────────────
 pick photos / PDFs / paste text                    pfm.import.start   → importId, limits checked
 shrink photos (≤1600 px JPEG), split          ───► pfm.import.add     → one item at a time (≤ 4 MB)
   pasted text into messages                          │ 1. text?  local parsers (§4.2)
                                                      │ 2. else / not matched: AI extraction (§4.3)
 review table (polls pfm.import.get)           ◄───   │ 3. validate every field (§4.4)
   ✓ ready   ⚠ needs checking   ⧉ duplicate           │ 4. dedupe (§4.5), category, project
 edit · confirm selected · discard                    │ 5. write suggested rows + receipt, one commit
                                               ───► pfm.import.confirm → booked (rollups, audit)
```

- **One item per request.** A 50-photo batch is 50 small calls, so a timeout or a bad photo loses one item, never the batch.
  The app keeps a queue and retries with the same `idemKey`; the server answers a repeat with the first result.
- **Multi-transaction items.** One PDF page or one pasted block can hold several transactions (a statement, five SMS in one
  paste). The extractor returns a list; each becomes its own row, numbered `itemNo.k`.
- **PDFs.** Text PDFs: the text layer is read in the Worker (no AI call when the local parsers match). Scanned PDFs: sent to
  the model as a document, ≤ 20 pages per item.

---

## 3. API

House convention (`POST /api {op, …}`, Firebase ID token, `idemKey` on every write).

| op | Payload → result |
|---|---|
| `pfm.import.start` | `{projectId?, sourceHint?, count}` → `{importId, remainingToday}`. `count` > what is left ⇒ `limit_reached` |
| `pfm.import.add` | `{importId, itemNo, kind: "image"\|"pdf"\|"text", data, sourceType?}` → `{rows:[{id, fields, verify, duplicateOf?}]}` |
| `pfm.import.get` | `{importId}` → the batch, its rows and counts (ready / needs checking / duplicate / failed) |
| `pfm.import.confirm` | `{importId, ids:[…], edits?:{id:{…}}}` → booked rows. A row with `verify` still non-empty after edits ⇒ refused for that row only (`needs_verification`), the others are booked |
| `pfm.import.discard` | `{importId, ids?}` → deletes suggested rows and their files |
| `pfm.project.upsert` / `.archive` / `.list` | Projects (§1.2) |
| `pfm.tx.search` | §5 |

`pfm/{uid}/imports/{importId}` keeps `{createdAt, projectId, counts, items:[{itemNo, sourceType, sha256, status, error?}]}`.
Suggested rows left unconfirmed for 30 days are deleted by the existing cron.

---

## 4. Extraction

### 4.1 Rules the extractor follows

1. **Never invent.** A field that cannot be read is `null` with a reason, not a likely value.
2. **Amounts are copied, not computed.** The model returns the amount **exactly as printed** (`"45,200.00"`), plus the
   currency as printed (`"ج.س"`, `"SDG"`, `"SAR"`). The Worker turns it into minor units; the model never does arithmetic.
3. **Totals, not lines.** On a shop receipt the transaction is the amount paid (grand total), not each item.
4. **Every transaction in the item**, in the order they appear.
5. **Arabic and English**, with Arabic-Indic digits (٠–٩) normalised to 0–9.
6. **Fees are separate.** A transfer fee printed beside the amount goes in `fee`, not added to `amount`.

### 4.2 Local parsers (text, no AI call)

Small, tested patterns for the payment messages Sawa users receive most (one module per provider, e.g. bank-app transfer
alerts and mobile-money confirmations). Each returns the same shape as the model. A message no parser recognises goes to
the model. Parsers are added from real, anonymised samples that users choose to send in-app («ساعدنا نتعرّف على هذه الرسالة»).

### 4.3 AI extraction

The Worker sends the item and these instructions, and requires the answer through a single tool, so the reply is always
valid JSON matching the schema:

```text
You read receipts, invoices and payment messages for a personal ledger.
Return every distinct transaction in the input by calling record_transactions once.
For each transaction:
- transaction_id: the reference / operation number exactly as printed, else null.
- timestamp: date and time as printed, converted to YYYY-MM-DD HH:MM:SS; null if absent. Do not use today's date.
- sender, recipient: names, phone numbers or entities as printed; null if absent.
- amount_text: the amount exactly as printed, digits and separators only. Never add, subtract or convert.
- currency_text: the currency as printed (symbol, code or word), else null.
- fee_text: a separately printed fee, else null.
- service_type: one of {list from §1.1}.
- category_hint: one of the user's categories: {id: name list}; null if unsure.
- unreadable: names of fields you could not read with confidence, with a short reason each.
Never guess. A null with a reason is always better than a plausible value.
The user's own names and numbers are: {names, phones, masked accounts}. Use them only to tell sender from recipient.
```

The model sees the user's category names and own identifiers, nothing else from the account.

### 4.4 Validation and `[Requires Verification]`

Each row's `verify` lists the fields a person must check. The batch never stops for a bad row.

| Field | Flagged when |
|---|---|
| `amount` | null; `toMinor()` refuses it; more decimals than the currency allows; for text sources, `amount_text` does not appear in the original message (digit-for-digit check, so a model slip cannot pass); amount ≤ 0 |
| `currency` | missing, ambiguous (`$`, `ريال` with no country), or not one of the twelve |
| `transaction_id` | null or reported unreadable |
| `timestamp` | null, in the future, or more than 3 years back |
| `kind` | neither side matches the user |
| `sender` / `recipient` | null on a transfer (`remittance`, `bank_transfer`) |

The app shows a flagged field as **«يحتاج تحقّقاً» / "Requires Verification"** with the reason, and the source image or text
next to it. A flagged row cannot be confirmed until the user fixes or accepts each field.

### 4.5 Duplicates

- With a reference: `refIx = HMAC(uidKey, provider + normalised ref)`. The row id is `m_{refIx[0:24]}`, written with
  `exists: false`, so the same receipt uploaded twice, or the SMS and its PDF, can never become two entries. The second
  shows as «مكرّر» with a link to the first.
- Without a reference: same amount, currency, minute and counterparty as an existing entry ⇒ shown as a *possible*
  duplicate; the user decides.

---

## 5. Search

`pfm.tx.search {sender?, recipient?, amount?, amountMin?, amountMax?, currency?, serviceType?, ref?, from?, to?,
projectId?, categoryId?, cursor?}` → `{items, cursor}`, 50 per page, newest first. Works on all entries (manual and imported).

| Field | How it is searched |
|---|---|
| Sender, recipient, reference | These are sealed, so Firestore cannot read them. Each row stores `ix: [...]`, keyed hashes (`HMAC(uidKey, token)`) of: each normalised name word (Arabic letters unified: أ/إ/آ→ا, ة→ه, ى→ي, diacritics removed), each phone number in full and its last 7 digits, and the reference. A search hashes the query the same way and uses `array-contains` |
| Amount | `amount` (exact, minor units) with `currency`, or a range `amountMin..amountMax` |
| Date | `occurredAt` between `from` and `to` (one day = exact date) |
| Service type, project, category | Equality on `serviceType`, `projectId`, `categoryId` |

Firestore allows one `array-contains` and one range per query, so the Worker sends the most selective filter to Firestore
(a name or reference first, then the date range) and applies the rest in memory, capped at 2,000 scanned rows
(`truncated: true` beyond that, with a hint to narrow the dates). New indexes: `(ix array, occurredAt desc)`,
`(projectId, occurredAt desc)`, `(serviceType, occurredAt desc)`, `(amount, occurredAt desc)`.

Free-text name search matches whole words only (that is the price of not storing names in clear). The app offers the
names it has already decrypted as suggestions while typing.

---

## 6. App

- **Entry point:** Ledger → «استيراد إيصالات» (also the Android share target and iOS share sheet: shared images, PDFs and
  text open the import screen with the items already in it).
- **Step 1:** pick the project (default «عامّ») and add items: camera, photos (many at once), PDF, or paste text.
- **Step 2:** progress per item; rows appear as they are read.
- **Step 3 — review table**, the brief's columns:
  `رقم العمليّة | التاريخ | المبلغ | المرسل | المستقبل | نوع الخدمة | المشروع`, plus a status mark.
  Filters: all · needs checking · duplicates. Tap a row: the source next to the fields, edit, change category/project.
  «تأكيد الجاهزة (N)» books every row with nothing to verify.
- **Export of a batch:** «نسخ JSON» gives the rows in the §7 shape (for another system or a support request); CSV export
  (P5) gains project, service type, sender, recipient and reference columns.
- Western digits throughout the money screens (`wLoc()`, C199). Texts in فصحى.

---

## 7. JSON shape (API and «نسخ JSON»)

The contract is **`import-batch.schema.json`** (JSON Schema draft-07), with a valid example in
`samples/import-batch.example.json`. It follows Khalid's `SawaWalletBatchResponse` (2026-11-08): `batch_id`,
`total_processed`, `receipts[]`, `sender`/`recipient` as `{name, account_identifier}` objects, `amount` as `{value, currency}`,
and a per-receipt `status` of `verified` or `requires_verification`. `pfm.import.get` returns this shape;
`pfm.import.add` returns the same `receipts[]` for one item.

```json
{
  "transaction_id": "TXN-88492031",
  "timestamp": "2026-06-07T14:30:00+02:00",
  "sender":    { "name": "خالد", "account_identifier": "+249123456789", "is_me": true },
  "recipient": { "name": "شركة النحلة للبترول", "account_identifier": "ACC-99281", "is_me": false },
  "kind": "expense",
  "amount": { "value": "150000.00", "minor": 15000000, "currency": "SDG" },
  "service_type": "fuel", "service_label": "تموين وقود تجاري",
  "project_id": "p_4d2b7e", "project_name": "إمدادات اللوجستيات",
  "category_id": "c_ops_supplies", "category": "مؤن التشغيل",
  "raw_source_type": "image_ocr",
  "status": "verified", "verify": [], "duplicate_of": null
}
```
(Abridged: `id`, `item_no`, `time_known` and `fee` are in the full example.)

### 7.1 Changes from the original schema, and why

| Original | Now | Why |
|---|---|---|
| `amount.value`: number (`150000.00`) | Decimal **string** `"150000.00"` + `minor` (integer) | No floats in money (§1 decision 2). JSON numbers become binary floats in JavaScript; `minor` is exactly what the ledger stores |
| Every field required, never empty | `transaction_id`, `timestamp`, names, `amount.value`, `currency` may be `null` | An unreadable field must be expressible without inventing a value. A number field cannot hold the text `[Requires Verification]` |
| `status` only | `status` **+ `verify: [{field, reason}]`** | The app must know *which* field to highlight and why. Rule: `requires_verification` exactly when `verify` is not empty |
| `timestamp` ending in `Z` | ISO 8601 with the place's offset (`+02:00` for Sudan) | A receipt prints local time. `14:30:00Z` would mean 16:30 in Khartoum. An offset keeps the printed time and is still one exact instant |
| `service_type`: free Arabic text | Code from §1.1 (`fuel`) + `service_label` (the printed text) | Free text cannot be filtered or counted reliably: «وقود»، «تموين وقود»، «بنزين» would be three types |
| `project_name`, `category`: names only | `project_id` / `category_id` + the name | Renaming a project or category must not break past entries or search |
| `currency`: any string | One of the twelve accepted currencies or `null` | Decision 8; anything else is flagged, not stored |
| — | `kind`, `fee`, `id`, `item_no`, `duplicate_of`, `is_me`, `time_known` | Income vs expense, separate fees, link back to the source item, duplicates (§4.5) |
| `total_processed` = receipts? | `total_processed` = input items; `counts.receipts` = receipts found; `failed_items[]` | One PDF can hold many receipts, and a blank photo holds none. The batch reports both without stopping |

**Markdown table.** The review screen and the chat summary show
`رقم العمليّة | التاريخ | المبلغ | المرسل | المستقبل | نوع الخدمة | المشروع`, with `[Requires Verification]` / «يحتاج تحقّقاً» in a
flagged cell. In JSON the same cell is `null` plus a `verify` entry.

---

## 8. Security and privacy

- The AI key lives only in Worker secrets (HANDOFF §1). The app never calls the AI provider.
- Consent first (I3). The consent screen says what is sent (the image or text of the receipt) and to whom.
- Images are checked by their bytes (`sniffLogo` rules; PDF by `%PDF-`), size-capped, and re-encoded on the phone before upload.
- Prompt injection: a receipt can contain text such as "ignore the rules". The model's only output is the tool call;
  the Worker validates every field (§4.4) and nothing from the model reaches another user or triggers any action
  beyond creating *suggested* rows for the same user.
- Sender, recipient, reference and project names are sealed; search uses keyed hashes (§5), never clear text.
- The source image/PDF is kept only as the entry's receipt (sealed, P5) and goes with the entry on delete; discarded
  rows delete their files. Account deletion already purges `pfm/{uid}`.
- Audit: `import.start`, `import.confirm` (count, total per currency), `import.discard`. Rate limits: 10 batches per hour.
- Unverified accounts cannot import (HANDOFF: no money features for unverified numbers).

---

## 9. Delivery

| Step | Scope | Exit check |
|---|---|---|
| **P6a** | Projects (§1.2), new tx fields, `pfm.tx.search` with blind index, CSV columns | Search by each of the seven fields finds the row; a name typed with أ finds one stored with ا; rollup per project = sum of its rows |
| **P6b** | Import for pasted text: local parsers, review table, confirm/discard, duplicates | 50 pasted messages ⇒ 50 rows in one batch; the same message twice ⇒ one entry; a message with no amount is flagged and the other 49 confirm |
| **P6c** | Images and PDFs through the AI service (needs I1–I3), share targets on Android and iOS | A test set of 100 labelled receipts: **no amount wrong and unflagged** (wrong amounts must be flagged, never silent); ≥ 90 % of fields correct; cost per item recorded |

Tests follow the P1–P5 pattern: `pfm-core.test.mjs` for parsers, normalisation and validation; `pfm-worker.test.mjs` with
the in-memory Firestore and a fake AI service returning fixed answers (including a wrong amount, a missing reference and an
injected instruction); `ui-check.mjs` for the review table in Arabic light and English dark.
