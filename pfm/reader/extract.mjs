// Sawa reader — from OCR'd table cells to one receipt in the shape of import-batch.schema.json (IMPORT-DESIGN.md §4).
// Rule: never invent. A field that does not parse cleanly is null and listed in `verify` with the reason.

import { findCells, prepCrop } from "./image.mjs";
import { matchLabel, normAr, parseDmyMon, parseMoney, parseGrouped, isNA, cleanEdges } from "./text.mjs";
import { toMinor } from "../pfm-core.mjs";

export const MIN_CONF = 80;
export const NAME_CONF = 75;             // below this a new recipient name is flagged                 // OCR confidence (0–100) below which a money or reference value is flagged

/** Words in a comment or name that say what the payment was for (first match wins). */
export const HINTS = [
  { re: /بنزين|جازولين|جالون|وقود|ديزل|gasoline|petrol|fuel/i, serviceType: "fuel", categoryId: "c_transport" },
  { re: /ترحيل|نقل|شحن|توصيل|delivery|transport/i, serviceType: "logistics", categoryId: "c_transport" },
  { re: /كهرباء|ايصالي|electricity|مياه|water/i, serviceType: "utility", categoryId: "c_utilities" },
  { re: /رصيد|زين|سوداني|ام تي ان|mtn|zain|sudani/i, serviceType: "telecom", categoryId: "c_telecom" },
  { re: /مصنعي|صيانه|تكييف|تكيف|دهان|سباك|كهربجي|نجار/i, serviceType: "other", categoryId: "c_maintenance" },
  { re: /فطور|غداء|غدا|عشاء|مطعم|restaurant|cafe|كافتيريا/i, serviceType: "retail", categoryId: "c_food" },
  { re: /ايجار|إيجار|rent/i, serviceType: "rent", categoryId: "c_rent" },
];

/**
 * cells: [{ a: {text, conf}, b: {text, conf} }] — the two halves of each table row, either order.
 * ctx:   { myAccounts: ["1111 2222 3333 0001", …], myName, projectId, projectName, source }
 * Returns null when this template does not match (too few labels found).
 */
export function extractFromCells(cells, tpl, ctx = {}) {
  const got = {}, conf = {}, alt = {}, variant = {};
  for (const c of cells) {
    const halves = [c.a, c.b].filter(Boolean);
    let lab = null, val = null;
    for (let i = 0; i < halves.length; i++) {
      const m = matchLabel(halves[i].text, tpl.labels);
      if (m && (!lab || m.score > lab.m.score)) { lab = { m, i }; val = halves[1 - i] || null; }
    }
    if (!lab || got[lab.m.field] !== undefined) continue;
    got[lab.m.field] = val ? val.text : "";
    variant[lab.m.field] = lab.m.variant;
    conf[lab.m.field] = val ? val.conf : 0;
    if (val && val.alt !== undefined) alt[lab.m.field] = val.alt;
  }
  if (Object.keys(got).length < tpl.minLabels) return null;

  const verify = [], flag = (field, reason) => verify.push({ field, reason });
  const own = new Set((ctx.myAccounts || []).map((a) => a.replace(/\D/g, "")));

  // Reference
  let transaction_id = null;
  if (got.transaction_id === undefined) flag("transaction_id", "not on the screenshot (cut off or scrolled)");
  else {
    const v = cleanEdges(got.transaction_id).replace(/\s+/g, "");
    if (!tpl.parse.transaction_id.pattern.test(v)) flag("transaction_id", `unreadable: "${got.transaction_id}"`);
    else if (conf.transaction_id < MIN_CONF) flag("transaction_id", `low OCR confidence (${Math.round(conf.transaction_id)})`);
    else transaction_id = v;
  }

  // Date and time
  let timestamp = null;
  if (got.timestamp === undefined) flag("timestamp", "not on the screenshot (cut off or scrolled)");
  else if (!(timestamp = parseDmyMon(got.timestamp, tpl.tz))) flag("timestamp", `unreadable: "${got.timestamp}"`);

  // Amount: exact shape, two decimals, confident OCR. Anything else is flagged, never repaired.
  let amount = { value: null, minor: null, currency: tpl.currency };
  if (got.amount === undefined) flag("amount", "not on the screenshot");
  else {
    const v = parseMoney(cleanEdges(got.amount), tpl.parse.amount);
    if (!v) flag("amount", `unreadable: "${got.amount}"`);
    else if (conf.amount < MIN_CONF) flag("amount", `low OCR confidence (${Math.round(conf.amount)}): "${got.amount}"`);
    else if (alt.amount !== undefined && parseMoney(cleanEdges(alt.amount), tpl.parse.amount) !== v) flag("amount", `two reads disagree: "${got.amount}" / "${alt.amount}"`);
    else if (+v <= 0) flag("amount", "zero");
    else amount = { value: v, minor: toMinor(v, tpl.currency), currency: tpl.currency };
  }

  // Accounts and parties
  // Accounts: all digit groups present; when the issuer's accounts end in a fixed group (Bankak: 0001) and the reading
  // starts with it, the groups came out in right-to-left order and are put back.
  const acct = (f) => {
    if (got[f] === undefined || isNA(got[f])) return null;
    const a = parseGrouped(got[f], tpl.parse.account.groups), sfx = tpl.parse.account.suffix;
    if (!a || !sfx) return a;
    const g = a.split(" ");
    if (g[g.length - 1] === sfx) return a;
    if (g[0] === sfx) return g.reverse().join(" ");
    return null;                                           // neither end is the suffix: misread, flagged below
  };
  const fromAcc = acct("from_account"), toAcc = acct("to_account");
  if (got.from_account !== undefined && !fromAcc) flag("sender", `account unreadable: "${got.from_account}"`);
  // «إلى» holding words, not an account number, names the payee (a biller such as ايصالي).
  const payee = got.to_account !== undefined && !toAcc && (got.to_account.match(/\d/g) || []).length < 6 && /\p{L}{2}/u.test(got.to_account)
    ? got.to_account.replace(/\s+/g, " ").trim() : null;
  if (got.to_account !== undefined && !toAcc && !payee) flag("recipient", `account unreadable: "${got.to_account}"`);
  const mine = (a) => !!a && own.has(a.replace(/\D/g, ""));
  const fromMe = mine(fromAcc), toMe = mine(toAcc);
  // Names: Arabic OCR misreads letters, but account numbers read reliably. A name the user already confirmed for this
  // account (ctx.knownAccounts, built from booked entries) wins over the OCR; a new, low-confidence name is flagged.
  const ocrName = got.to_name && !isNA(got.to_name) ? got.to_name.replace(/\s+/g, " ").trim() : null;
  const known = toAcc && ctx.knownAccounts ? ctx.knownAccounts[toAcc.replace(/\D/g, "")] : null;
  const toName = known || ocrName || payee;
  if (!known && ocrName && conf.to_name < NAME_CONF) flag("recipient", `name unclear (OCR confidence ${Math.round(conf.to_name)})`);
  const sender = { name: fromMe ? ctx.myName || null : null, account_identifier: fromAcc, is_me: fromMe };
  const recipient = { name: toName, account_identifier: toAcc, is_me: toMe };
  if (!toAcc && !toName) flag("recipient", "no name or account");
  if (!fromAcc) flag("sender", "no account");

  // Income or spending comes from who sent and who received. The green success screen is shown only to the person
  // who made the transfer, so its sender account is the user's own: if it is not known yet, it is proposed
  // (own_account_hint) and the row is flagged once, until the user confirms the account.
  // A bill payment: the type says so, or a bill-ID row is present (that row reads reliably; the type text may not).
  const isBill = got.bill_id !== undefined || !!(got.trx_type && (tpl.billTypes || []).some((b) => normAr(got.trx_type).includes(normAr(b))));
  const successScreen = isBill || (tpl.senderOnly && tpl.senderOnly.includes(variant.from_account));
  let kind = null, own_account_hint = null;
  if (successScreen && fromAcc && !fromMe) {
    own_account_hint = fromAcc;
    kind = toMe ? "transfer" : "expense";
    flag("kind", `new account ${fromAcc} sent this ${isBill ? "payment" : "transfer"}: confirm it is yours`);
  } else if (fromMe && toMe) kind = "transfer";
  else if (fromMe) kind = "expense";
  else if (toMe) kind = "income";
  else flag("kind", (ctx.myAccounts || []).length ? "neither account is one of yours" : "add your account numbers to tell income from spending");

  // A failed or pending transfer must not be booked as money moved.
  if (got.status !== undefined && !tpl.success.some((s) => normAr(s) === normAr(got.status))) {
    const failed = matchLabel(got.status, { failure: tpl.failure || [] }, 0.6);
    if (failed || !tpl.failure) flag("kind", `status is "${got.status}", not success`);
  }

  const billId = got.bill_id ? got.bill_id.replace(/\s+/g, "") : null;
  const note = got.note && !isNA(got.note) ? got.note.replace(/\s+/g, " ").trim() : billId ? `${(tpl.billTypes || ["Bill"])[0]} ${billId}` : null;
  const hintText = `${note || ""} ${toName || ""} ${got.trx_type || ""}`;
  const hint = HINTS.find((h) => h.re.test(normAr(hintText)) || h.re.test(hintText));

  return {
    template: `${tpl.id}@${tpl.version}`,
    transaction_id, timestamp, time_known: !!timestamp,
    sender, recipient, kind, amount, fee: null,
    service_type: hint ? hint.serviceType : tpl.serviceType,
    service_label: got.trx_type ? got.trx_type.trim() : null,
    bill_id: billId,
    note,
    project_id: ctx.projectId || "p_general", project_name: ctx.projectName || "General",
    category_id: hint ? hint.categoryId : "c_uncategorized",
    raw_source_type: ctx.source || "image_ocr",
    own_account_hint,
    name_source: known ? "known_account" : ocrName ? "ocr" : null,
    status: verify.length ? "requires_verification" : "verified",
    verify,
  };
}

/**
 * Whole image → receipt. `ocr(crop, mode)` is the engine, injected; it returns {text, conf}. Modes: "mix" (Arabic and
 * English), "ara", "eng", "num" (English digits). In the app it is tesseract.js in a Web Worker; in tests, a stub.
 */
const hasArabic = (s) => /[\u0600-\u06FF]/.test(s);

async function readText(ocr, crop) {
  const a = await ocr(crop, "mix");
  // Arabic text: an Arabic-only read usually keeps word spaces and does not turn short words into Latin junk.
  if (hasArabic(a.text) || a.conf < 80) { const b = await ocr(crop, "ara"); if (b.text && b.conf > a.conf) return b; }
  return a;
}

export async function readImage(img, ocr, templates, ctx = {}) {
  const cells = findCells(img);
  for (const tpl of templates) {
    const rows = [];
    for (const c of cells) {
      if (c.whole) continue;
      const parts = [c.right, c.left].map((box) => ({ box, crop: prepCrop(img, box, c.bg, 3) }));
      // Which half is the label? Try both, with fallbacks: labels are short, OCR sometimes reads Arabic as Latin, and a
      // short Latin label can turn to noise at 3× ("Trx. ID") while it reads cleanly at 2×.
      let lab = null;
      for (const [mode, scale] of [["mix", 3], ["ara", 3], ["eng", 3], ["mix", 2], ["eng", 2]]) {
        for (let i = 0; i < 2 && !lab; i++) {
          const crop = scale === 3 ? parts[i].crop : prepCrop(img, parts[i].box, c.bg, scale);
          const r = await ocr(crop, mode), m = matchLabel(r.text, tpl.labels);
          if (m) lab = { i, m, r };
        }
        if (lab) break;
      }
      if (!lab) continue;
      const v = parts[1 - lab.i], kind = tpl.read[lab.m.field];
      let val;
      if (kind === "num") {
        val = await ocr(v.crop, "num");
        if (lab.m.field === "amount") val.alt = (await ocr(v.crop, "eng")).text;   // second, independent read (§4.4)
        // an account field holding words (a biller name): read it again as text
        if (/_account$/.test(lab.m.field) && (val.text.match(/\d/g) || []).length < 6) val = await readText(ocr, v.crop);
      } else if (lab.m.field === "status") {
        // a short word («نجاح») that the mixed engine can turn into Latin junk: accept the first read that is a known
        // success word, else keep the first read (and the row is flagged as not successful)
        const reads = [];
        for (const mode of ["mix", "ara", "eng"]) {
          const r = await ocr(v.crop, mode); reads.push(r);
          if (tpl.success.some((w) => normAr(w) === normAr(r.text))) break;
        }
        val = reads.find((r) => tpl.success.some((w) => normAr(w) === normAr(r.text))) || reads[0];
      } else val = await readText(ocr, v.crop);
      rows.push({ a: { text: lab.m.variant, conf: lab.r.conf }, b: val });
    }
    const r = extractFromCells(rows, tpl, ctx);
    if (r) return { ...r, cells: cells.length };
  }
  return null;
}

/**
 * After the user confirms which accounts are theirs, decide income or spending again without re-reading the image:
 * same rule as extractFromCells (sender = me → expense, recipient = me → income, both → transfer).
 */
export function recomputeKind(r, myAccounts) {
  const own = new Set((myAccounts || []).map((a) => String(a).replace(/\D/g, "")));
  const mine = (a) => !!a && own.has(String(a).replace(/\D/g, ""));
  const fromMe = mine(r.sender.account_identifier), toMe = mine(r.recipient.account_identifier);
  const verify = r.verify.filter((v) => !(v.field === "kind" && /confirm it is yours|neither account|add your account/.test(v.reason)));
  let kind = r.kind;
  if (fromMe && toMe) kind = "transfer";
  else if (fromMe) kind = "expense";
  else if (toMe) kind = "income";
  else if (!r.own_account_hint) { kind = null; verify.push({ field: "kind", reason: own.size ? "neither account is one of yours" : "add your account numbers to tell income from spending" }); }
  else verify.push({ field: "kind", reason: `new account ${r.own_account_hint} sent this transfer: confirm it is yours` });
  const own_account_hint = fromMe ? null : r.own_account_hint;
  return { ...r, kind, own_account_hint, sender: { ...r.sender, is_me: fromMe }, recipient: { ...r.recipient, is_me: toMe },
    verify, status: verify.length ? "requires_verification" : "verified" };
}
