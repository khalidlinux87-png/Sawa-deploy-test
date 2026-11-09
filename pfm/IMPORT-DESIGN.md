# Sawa Wallet Engine: bulk receipt and payment-message import (P6) design

Status: rev 4 · **Bankak import built end to end (§4.7, §4.8, C273)**; search, projects and other issuers not built · Date: 2026-11-09 (rev 2: Sawa's own reader instead of a paid AI service, decision I1) · Extends `DESIGN.md` (PFM rev 9, P1–P5 built)

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
| I1 | Which service reads the images and text? | **Answered 2026-11-09: Sawa's own reader, no paid service** (§4.3). Text goes through templates written for chosen issuers; images are read **on the phone** by an open-source OCR engine, then the same templates pick out the fields. No cost per receipt, and no third party sees the receipts. A paid AI service stays only as an optional fallback, designed and off (`PFM_IMPORT_AI=0`) |
| I2 | Limits | No cost per item now, so limits only protect the server: 500 items per user per day, 50 per batch. Kill switch `PFM_IMPORT=0` |
| I3 | Consent | Images are read on the phone; the server gets the OCR text and the photo, sealed as the entry's receipt (as in P5). No extra consent screen is needed for that. Only «ساعدنا في التحسين» (sending an anonymised sample, §4.6) asks first, every time |
| I4 | Projects vs tags | **Projects are a new field** (one per entry, default "General"); tags stay free-form and many per entry. A project is the "ledger context" from the brief: a shop, a building job, a family event |
| I5 | Reading SMS automatically on Android | **No.** Google Play restricts the SMS permission to default SMS apps. The user pastes or *shares* messages to Sawa (Android share target, iOS share sheet) |
| I6 | **Which issuers first?** Started 2026-11-09: **Bankak** (template `bankak@1`, §4.7). Next: other bank apps and mobile-money services, as samples arrive | The bank apps, mobile-money services and SMS senders Sawa must read on day one. Each needs ~20 real samples (§4.6). Without them the reader works only in its generic mode, where every row is flagged for checking |

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
| `category` | التصنيف العامّ | `categoryId` | The user's rules first, then the template's service type mapped to a category, else `c_uncategorized` |
| `raw_source_type` | نوع المصدر | `importSource` | `image_ocr` · `pdf_document` · `sms_notification` · `email_forward` |

Also on each imported row: `source: "import"`, `importId`, `status: "suggested"`, `verify: [field…]` (§4.4),
`confidence` per field, and `hasReceipt` (the photo or PDF page is kept as the entry's receipt, P5).

**Direction.** `kind` comes from who the user is: user = recipient ⇒ `income`; user = sender ⇒ `expense`; both are the
user's own accounts ⇒ `transfer`. The user's names, phone numbers and masked account numbers (from the profile and
`payoutAccounts`) are given to the matcher, never guessed. Unknown ⇒ flagged `kind`.

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
 photos: OCR on the phone (§4.3)               ───► pfm.import.add     → one item at a time
   → words + boxes + confidence                       │ 1. find the issuer's template (§4.2)
 text: split into messages                            │ 2. extract; no template → generic mode
 review table (polls pfm.import.get)           ◄───   │ 3. validate every field (§4.4)
   ✓ ready   ⚠ needs checking   ⧉ duplicate           │ 4. dedupe (§4.5), category, project
 edit · confirm selected · discard                    │ 5. write suggested rows + receipt, one commit
                                               ───► pfm.import.confirm → booked (rollups, audit)
```

- **One item per request.** A 50-photo batch is 50 small calls, so a timeout or a bad photo loses one item, never the batch.
  The app keeps a queue and retries with the same `idemKey`; the server answers a repeat with the first result.
- **Multi-transaction items.** One PDF page or one pasted block can hold several transactions (a statement, five SMS in one
  paste). The extractor returns a list; each becomes its own row, numbered `itemNo.k`.
- **PDFs.** Text PDFs: the text layer is read in the Worker and goes through the templates. Scanned PDFs: each page is
  rendered on the phone and read like a photo, ≤ 20 pages per item.
- **The image is not needed to extract.** The phone sends the OCR result (words, boxes, confidence) for extraction and the
  shrunk photo only to keep as the receipt. The templates run in the Worker, so a fix to a template reaches everyone at once,
  and the Worker still validates every field (§4.4).

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
2. **Amounts are copied, not computed.** The reader returns the amount **exactly as printed** (`"45,200.00"`), plus the
   currency as printed (`"ج.س"`, `"SDG"`, `"SAR"`). The Worker turns it into minor units; nothing is added or converted.
3. **Totals, not lines.** On a shop receipt the transaction is the amount paid (grand total), not each item.
4. **Every transaction in the item**, in the order they appear.
5. **Arabic and English**, with Arabic-Indic digits (٠–٩) normalised to 0–9.
6. **Fees are separate.** A transfer fee printed beside the amount goes in `fee`, not added to `amount`.

### 4.2 Templates (one per issuer)

A template is a small file in `pfm/templates/` (one per bank app, mobile-money service or SMS sender) that says how to
recognise the issuer and where each field is. The same template serves its SMS, its email and its screenshot receipt.

```js
// pfm/templates/example-bank.mjs — illustrative only; real templates are written from real samples (§4.6)
export default {
  id: "example-bank", version: 3,
  detect: { anyOf: ["Example Bank", "بنك المثال"], smsSenders: ["EXBANK"] },
  fields: {
    transaction_id: { label: ["رقم العملية", "Transaction ID", "Ref"], value: /[A-Z0-9-]{6,30}/ },
    amount:         { label: ["المبلغ", "Amount"], value: "money" },          // currency must be printed; never assumed
    timestamp:      { label: ["التاريخ", "Date"], value: "datetime", formats: ["DD-MMM-YYYY HH:mm:ss", "DD/MM/YYYY hh:mm A"], tz: "Africa/Khartoum" },
    sender:         { label: ["من", "From"], value: "party" },
    recipient:      { label: ["إلى", "To"],  value: "party" },
    fee:            { label: ["الرسوم", "Fee"], value: "money", optional: true },
  },
  serviceType: { default: "bank_transfer", byText: { "كهرباء": "utility", "رصيد": "telecom" } },
  sms: [/تم تحويل (?<amount>[\d,.]+) (?<currency>\S+) إلى (?<recipient>.+?) رقم العملية (?<transaction_id>\S+)/],
};
```

- **On a photo:** the reader finds a label's words, then takes the value on the same line (on the side the layout puts
  it, right-to-left aware) or on the line below, using the word boxes from the OCR.
- **On text:** the `sms` patterns run first, then the label search on the plain text.
- **Generic mode** (no template matches): money-like, date-like and reference-like values next to common Arabic and
  English labels. Every field it finds is still flagged (`reason: "unknown layout"`), so the user checks each row.
- Templates carry a `version`; each imported row records `template: "example-bank@3"`, so rows read by a faulty template
  can be listed for re-checking.

### 4.3 Sawa's reader (OCR on the phone)

- **Engine:** Tesseract (open source, Apache 2.0) compiled to WebAssembly (`tesseract.js`), with the Arabic and English
  models. It runs inside the app in a background thread, so it works the same in the browser, the Android app and the
  iOS app. The engine and models (a few MB) are **served from sawaaap.com**, not a CDN, downloaded only when the user
  first opens Import, then cached by `sw.js`.
- **Why not the phone's built-in reader:** Google ML Kit's text recognition does not read Arabic. Apple's Vision can be
  tried later as a faster path on iPhone, behind the same interface, if it reads these receipts well.
- **Before OCR:** crop to the receipt, grey-scale, scale so text is ~30 px high; for photos of paper also straighten and
  raise contrast. Screenshots from bank apps need almost nothing and read best.
- **Output to the Worker:** `{words:[{text, box, conf}], lines, engine: "tesseract@ara+eng", ms}`.
- **Speed (to be measured):** a few seconds per screenshot on a mid-range phone; a 50-item batch runs in the background
  with a progress bar, and rows appear as each item finishes.
- **Alternative to compare in P6c:** PaddleOCR's Arabic model with ONNX Runtime Web: a bigger download, maybe more
  accurate on paper receipts. The test set (§4.6) decides; the interface stays the same.
- **Optional paid fallback (off):** with `PFM_IMPORT_AI=1`, an item the reader cannot handle could go to an AI service,
  after the user agrees for that item. Not planned now.

### 4.4 Validation and `[Requires Verification]`

Each row's `verify` lists the fields a person must check. The batch never stops for a bad row.

| Field | Flagged when |
|---|---|
| `amount` | null; `toMinor()` refuses it; any digit's OCR confidence below the threshold; two places on the receipt that show the amount (e.g. amount and total) disagree; more decimals than the currency allows; for text sources, the amount does not appear in the original message (digit-for-digit check); amount ≤ 0 |
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

### 4.6 Training and measuring

"Training" happens at three levels, cheapest first:

1. **Templates (P6b–P6c).** For each issuer chosen in I6: collect ~20 samples covering its variants (transfer, bill
   payment, airtime, failed transaction, old and new app versions), label them, write the template, and run the test
   set. For fixed layouts, which bank receipts and notifications are, this is more precise than a learned model.
2. **Fine-tuning the OCR (P6d, only if needed).** If the test set shows OCR misreads on a particular font, Tesseract's
   Arabic model is fine-tuned on line images cropped from the samples, with their correct text (a few hundred lines),
   using the official `tesstrain` tools. This runs on a computer or in a GitHub Actions job, never on the phone; the
   result is a new model file, served like the first.
3. **Learning from corrections (ongoing).** Each correction in the review table is counted per template and field
   (`pfm/{uid}/importStats`, counts only, no text). A field that is corrected often marks its template for review. A
   user's own corrections also become their rules (e.g. "this recipient → this category", as P2 rules do).

**Labelled samples.** One folder per issuer: the image or text, plus a label file in the shape of
`import-batch.schema.json` (only the fields printed on the sample). `reader-eval.mjs` runs the reader on every sample and
prints, per issuer and field, how many are right, flagged, or **wrong and unflagged** (must be zero for amounts).

**Where samples live.** ⚠️ This repository (Sawa-deploy-test) is **public**. Real receipts hold names, phone numbers and
account numbers, so they must never be committed here. Real samples go in a **private** repository (or a private R2
bucket); only synthetic or fully anonymised samples go in `pfm/samples/`. Samples users send through «ساعدنا في التحسين»
are masked on the phone (names, phones, account numbers) before upload, and kept sealed for 90 days.

### 4.7 First template: Bankak (2026-11-09)

Built in `pfm/reader/`: `image.mjs` (ruled rows → cells → label and value halves, borders trimmed, crops prepared),
`text.mjs` (Arabic normalisation, label matching, dates, strict money and account shapes), `extract.mjs` (cells → one
receipt in the schema's shape, with `verify`), `templates/bankak.mjs` (v2), `reader.test.mjs` (18 tests, invented data only),
`reader-eval.mjs` + `dev/ocr-node.mjs` (Tesseract in Node, to measure on private samples).

How it reads a screenshot: find the ruled rows; split each into two halves; OCR both (Arabic+English, then Arabic only,
then English if no label is recognised); the half that matches a label is the label. Digit fields (reference, date,
accounts, amount) are re-read with the English engine, because Arabic line direction reverses digit groups. **The amount
is read twice with two engines and both reads must agree**, have the exact shape `1,234.00`, and clear the confidence bar.

Template facts (confirmed by Khalid, 2026-11-09): currency SDG, Sudan time, 16-digit accounts **always ending in 0001**
(a reading that starts with 0001 came out right-to-left and is put back in order), two decimals.
**Income or spending follows sender and recipient.** The green success screen is shown only to the person who made the
transfer, so its sender account is the user's own: a new one is proposed (`own_account_hint`) and confirmed once.
Samples and their correct answers: private repository **Sawa-Samples** (never in this public one).
A *Status* other than Success/نجاح is flagged. Income vs spending comes from the user's own account numbers.
Names: a name already confirmed for that account number wins over OCR (`ctx.knownAccounts`); a new name read with low
confidence is flagged.

**Results on the first 7 real screenshots** (4 layouts: green success screen and white history screen, each in Arabic
and English; two were scrolled so the top rows were cut off), ~3 s per image in Node:

| Field | Right | Flagged | **Wrong, not flagged** | Not on screen |
|---|---|---|---|---|
| Reference | 5 | 0 | **0** | 2 |
| Date and time | 5 | 1 (top row cut) | **0** | 1 |
| Amount | 6 | 1 (low confidence) | **0** | 0 |
| From / to account | 7 / 7 | 0 | **0** | 0 |
| Recipient name | 4 | 2 | 1 (Arabic) | 0 |
| Comment | 2 | 0 | 4 (Arabic letters) | 1 |

Before the two-read rule one read gave `55000.00` for `35000.00`; it is now caught by the second read. Comments are
shown for the user to edit and are never used for money.

### 4.8 In the app (C273)

Ledger → «استيراد». The app loads `/ocr/v1/sawa-reader.js` (built from this folder by `dev/bundle.mjs`) and the OCR
files from its own origin, reads each picked image on the phone, and shows a review card per image: status (ready /
needs checking / repeated / between your accounts / not recognised), the flags in plain words, editable amount, date,
type, party, category and note, and an "add" tick (on for clean rows, off for flagged ones until the user checks them).
A new sender account on a success screen asks «هل هو حسابك؟» once (`pfm.import.prefs.set`), then every row is decided
again (`recomputeKind`; category and party follow a type change). Saving calls `pfm.tx.add` with `ref {issuer, id}`
(or an idemKey when the screen shows no reference, with a note that a repeat would not be caught), then attaches the
shrunk screenshot as the receipt, then stores the confirmed names per account. Repeats: inside a batch by reference,
across batches by the server (`duplicate: true`).

Not built yet from this design: the server-side import batch (§3 `pfm.import.*` beyond prefs), suggested rows,
projects (§1.2), seven-field search (§5), text/SMS import (§4.2), PDFs, share targets, other issuers.

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

- Receipts are read on the phone and never go to a third party (I1). The server gets the OCR words and the photo, which is
  sealed as the entry's receipt (P5).
- Samples for improving the reader are sent only when the user taps «ساعدنا في التحسين», masked first (§4.6).
- Images are checked by their bytes (`sniffLogo` rules; PDF by `%PDF-`), size-capped, and re-encoded on the phone before upload.
- OCR text is untrusted input: templates only match patterns and copy values, every field is validated (§4.4), and
  the only effect of an import is *suggested* rows for the same user.
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
| **P6c** | Sawa's reader: OCR on the phone, templates for the issuers chosen in I6, scanned PDFs, share targets on Android and iOS, `reader-eval.mjs` | On the labelled test set (≥ 20 samples per issuer): **no amount wrong and unflagged**; ≥ 95 % of fields right on screenshots, ≥ 85 % on photos of paper; time per item recorded on a mid-range Android phone |
| **P6d** | Only if P6c shows OCR errors: fine-tuned Arabic OCR model, PaddleOCR comparison | The same test set improves, with no amount wrong and unflagged |

Tests follow the P1–P5 pattern: `pfm-core.test.mjs` for parsers, normalisation and validation; `pfm-worker.test.mjs` with
the in-memory Firestore and fixed OCR results (including a misread digit, a missing reference and an unknown layout); `ui-check.mjs` for the review table in Arabic light and English dark.
