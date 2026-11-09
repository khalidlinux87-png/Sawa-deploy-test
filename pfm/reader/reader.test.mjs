// Usage: node pfm/reader/reader.test.mjs
// All names, accounts and numbers below are invented. Real samples live in the private samples repository only.
import assert from "node:assert/strict";
import * as T from "./text.mjs";
import { findCells, findRules, prepCrop } from "./image.mjs";
import { extractFromCells, readImage } from "./extract.mjs";
import bankak from "./templates/bankak.mjs";

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

const ME = "1111 2222 3333 0001", OTHER = "9999 8888 7777 0001";
const ctx = { myAccounts: [ME], myName: "Test User" };
const cell = (label, value, conf = 95, alt) => ({ a: { text: label, conf: 95 }, b: { text: value, conf, ...(alt !== undefined ? { alt } : {}) } });
const english = (over = {}) => [
  cell("Trx. ID", over.id ?? "20000000001"),
  cell("Date & Time", over.date ?? "02-Nov-2026 14:02:10"),
  cell("From Account", over.from ?? ME),
  cell("To Account", over.to ?? OTHER),
  cell("To Account Title", over.name ?? "Test Supplier Ltd", over.nameConf ?? 95),
  cell("Mobile Number", "N/A"),
  cell("Comment", over.note ?? "5 gallons petrol"),
  cell("Amount", over.amount ?? "250,000.00", over.amountConf ?? 95, over.alt ?? (over.amount ?? "250,000.00")),
];

await t("text: Arabic normalisation and digits", () => {
  assert.equal(T.normAr("إسم المرسل إليه"), T.normAr("اسم المرسل اليه"));
  assert.equal(T.normAr("مصنعيّة"), T.normAr("مصنعيه"));
  assert.equal(T.westernDigits("٢٥٠٬٠٠٠٫٠٠"), "250٬000٫00");
});

await t("text: labels match despite OCR slips, and only real labels", () => {
  assert.equal(T.matchLabel("رقمالعملية", bankak.labels).field, "transaction_id");
  assert.equal(T.matchLabel("| التاريخوالوقت", bankak.labels).field, "timestamp");
  assert.equal(T.matchLabel("To Account Title", bankak.labels).field, "to_name");
  assert.equal(T.matchLabel("Amount", bankak.labels).field, "amount");
  assert.equal(T.matchLabel("Success", bankak.labels), null);
  assert.equal(T.matchLabel("250,000.00", bankak.labels), null);
});

await t("text: dates in Sudan time, impossible dates refused", () => {
  assert.equal(T.parseDmyMon("02-Nov-2026 14:02:10", "Africa/Khartoum"), "2026-11-02T14:02:10+02:00");
  assert.equal(T.parseDmyMon("‎03-Nov-2026 15:27:02‏", "Africa/Khartoum"), "2026-11-03T15:27:02+02:00");
  assert.equal(T.parseDmyMon("31-Nov-2026 10:00:00", "Africa/Khartoum"), null);
  assert.equal(T.parseDmyMon("02-Xyz-2026 10:00:00", "Africa/Khartoum"), null);
});

await t("text: money shape is strict, never repaired", () => {
  assert.equal(T.parseMoney("50,000.00"), "50000.00");
  assert.equal(T.parseMoney("35000.00"), "35000.00");
  assert.equal(T.parseMoney("5,000,000.00"), "5000000.00");
  assert.equal(T.parseMoney("50,00.00"), null);        // misplaced separator
  assert.equal(T.parseMoney("50000.0"), null);         // a decimal lost
  assert.equal(T.parseMoney("5O,000.00"), null);       // letter O for zero
  assert.equal(T.parseMoney("l 50,000.00"), null);     // edge mark left in: cleaned before, never inside parseMoney
  assert.equal(T.cleanEdges("| 50,000.00"), "50,000.00");
  assert.equal(T.cleanEdges("20000000001 j"), "20000000001");
  assert.equal(T.cleanEdges("1 50,000.00"), "1 50,000.00");   // a digit is never dropped
});

await t("text: account numbers need all 16 digits", () => {
  assert.equal(T.parseGrouped("1111 2222\n3333 0001", [4, 4, 4, 4]), ME);
  assert.equal(T.parseGrouped("1111 2222 3333 001", [4, 4, 4, 4]), null);
});

await t("extract: a clean English success screen is verified", () => {
  const r = extractFromCells(english(), bankak, ctx);
  assert.equal(r.status, "verified");
  assert.deepEqual(r.amount, { value: "250000.00", minor: 25000000, currency: "SDG" });
  assert.equal(r.transaction_id, "20000000001");
  assert.equal(r.timestamp, "2026-11-02T14:02:10+02:00");
  assert.equal(r.kind, "expense");
  assert.deepEqual(r.sender, { name: "Test User", account_identifier: ME, is_me: true });
  assert.equal(r.recipient.name, "Test Supplier Ltd");
  assert.equal(r.service_type, "fuel");
  assert.equal(r.category_id, "c_transport");
  assert.equal(r.template, "bankak@3");
});

await t("extract: Arabic labels, incoming transfer, Arabic note hints", () => {
  const r = extractFromCells([
    cell("رقم العملية", "20000000002"), cell("التاريخ والوقت", "04-Nov-2026 20:12:03"), cell("نوع العملية", "تحويل إلى حساب آخر"),
    cell("المبلغ", "2000000.00", 95, "2000000.00"), cell("من", OTHER), cell("إلى", ME), cell("الحالة", "نجاح"),
    cell("إسم المرسل اليه", "مستخدم تجريبي"), cell("التعليق", "ترحيل مواد"),
  ], bankak, ctx);
  assert.equal(r.status, "verified");
  assert.equal(r.kind, "income");
  assert.equal(r.service_type, "logistics");
  assert.equal(r.service_label, "تحويل إلى حساب آخر");
});

await t("extract: the two amount reads must agree", () => {
  const r = extractFromCells(english({ amount: "55,000.00", alt: "35,000.00" }), bankak, ctx);
  assert.equal(r.amount.value, null);
  assert.equal(r.status, "requires_verification");
  assert.match(r.verify.find((v) => v.field === "amount").reason, /disagree/);
});

await t("extract: a low-confidence or misshapen amount is flagged, not guessed", () => {
  assert.equal(extractFromCells(english({ amountConf: 43 }), bankak, ctx).amount.value, null);
  assert.equal(extractFromCells(english({ amount: "250,00.00" }), bankak, ctx).amount.value, null);
});

await t("extract: a scrolled screenshot flags what is missing and keeps the rest", () => {
  const rows = english().filter((c) => !/Trx|Date/.test(c.a.text));
  const r = extractFromCells(rows, bankak, ctx);
  assert.deepEqual(r.verify.map((v) => v.field).sort(), ["timestamp", "transaction_id"]);
  assert.equal(r.amount.value, "250000.00");
  assert.equal(r.status, "requires_verification");
});

await t("extract: a failed transfer is flagged; unreadable status noise is not", () => {
  const st = (w) => extractFromCells([...english(), cell("Status", w)], bankak, ctx).verify.some((v) => v.field === "kind");
  assert.ok(st("Failed"));
  assert.ok(st("Faild"));                  // slightly misread failure word
  assert.ok(st("فشل"));
  assert.ok(st("قيد التنفيذ"));
  assert.ok(!st("Success"));
  assert.ok(!st("نجاح"));
  assert.ok(!st("gle"));                   // OCR noise for «نجاح»: no false alarm
});

await t("extract: on a history screen, without the user's accounts, income vs spending is flagged", () => {
  const hist = english().map((c) => (c.a.text === "From Account" ? cell("From", ME) : c.a.text === "To Account" ? cell("To", OTHER) : c));
  const r = extractFromCells(hist, bankak, {});
  assert.equal(r.kind, null);
  assert.ok(r.verify.some((v) => v.field === "kind"));
});

await t("extract: a known account's confirmed name beats a shaky OCR name", () => {
  const knownAccounts = { [OTHER.replace(/\D/g, "")]: "Test Supplier Ltd" };
  const shaky = english({ name: "Tcst Suppl1er Lfd", nameConf: 50 });
  assert.ok(extractFromCells(shaky, bankak, ctx).verify.some((v) => v.field === "recipient"));
  const r = extractFromCells(shaky, bankak, { ...ctx, knownAccounts });
  assert.equal(r.recipient.name, "Test Supplier Ltd");
  assert.equal(r.name_source, "known_account");
  assert.equal(r.status, "verified");
});

await t("extract: account groups read right-to-left are put back; a missing 0001 is flagged", () => {
  const r = extractFromCells(english({ from: "0001 3333 2222 1111", to: "0001 7777 8888 9999" }), bankak, ctx);
  assert.equal(r.sender.account_identifier, ME);
  assert.equal(r.recipient.account_identifier, OTHER);
  assert.equal(r.kind, "expense");
  const bad = extractFromCells(english({ to: "9999 8888 7777 0007" }), bankak, ctx);
  assert.equal(bad.recipient.account_identifier, null);
  assert.ok(bad.verify.some((v) => v.field === "recipient"));
});

await t("extract: a success screen proposes its sender account as the user's own", () => {
  const r = extractFromCells(english(), bankak, { myAccounts: [] });
  assert.equal(r.own_account_hint, ME);
  assert.equal(r.kind, "expense");
  assert.match(r.verify.find((v) => v.field === "kind").reason, /confirm it is yours/);
  // Once confirmed, the same screen is clean.
  assert.equal(extractFromCells(english(), bankak, ctx).own_account_hint, null);
  // The history screen ("From") is not proof of ownership: an incoming transfer shows someone else there.
  const hist = english().map((c) => (c.a.text === "From Account" ? cell("From", OTHER) : c.a.text === "To Account" ? cell("To", ME) : c));
  const h = extractFromCells(hist, bankak, ctx);
  assert.equal(h.kind, "income");
  assert.equal(h.own_account_hint, null);
});

await t("text: one-decimal amounts only where the template allows them, padded to the currency", () => {
  assert.equal(T.parseMoney("200000.0", { decimals: 2, minDecimals: 1 }), "200000.00");
  assert.equal(T.parseMoney("200000.00", { decimals: 2, minDecimals: 1 }), "200000.00");
  assert.equal(T.parseMoney("200000.0"), null);                       // default stays strict
  assert.equal(T.parseMoney("200000.", { decimals: 2, minDecimals: 1 }), null);
});

await t("extract: a bill payment — biller name in «إلى», always spending from the user", () => {
  const bill = (over = {}) => [
    cell("رقم العملية", "20000000009"), cell("التاريخ والوقت", "09-Nov-2026 19:17:57"), cell("نوع العملية", "سداد فاتورة"),
    cell("المبلغ", "200000.0", 95, "200000.0"), cell("من", over.from ?? ME), cell("إلى", "ايصالي"),
    cell("مُعرف الفاتورة", "1111222233334444555566"), cell("الحالة", "نجاح"),
  ];
  const r = extractFromCells(bill(), bankak, ctx);
  assert.equal(r.status, "verified", JSON.stringify(r.verify));
  assert.equal(r.kind, "expense");
  assert.deepEqual(r.amount, { value: "200000.00", minor: 20000000, currency: "SDG" });
  assert.deepEqual(r.recipient, { name: "ايصالي", account_identifier: null, is_me: false });
  assert.equal(r.bill_id, "1111222233334444555566");
  assert.equal(r.note, "سداد فاتورة 1111222233334444555566");
  assert.equal(r.service_type, "utility");
  assert.equal(r.category_id, "c_utilities");
  // paid from an account Sawa doesn't know yet: proposed as the user's own, asked once
  const n = extractFromCells(bill({ from: "4444 3333 2222 0001" }), bankak, ctx);
  assert.equal(n.kind, "expense");
  assert.equal(n.own_account_hint, "4444 3333 2222 0001");
  assert.match(n.verify.find((v) => v.field === "kind").reason, /payment: confirm it is yours/);
});

await t("extract: not a Bankak screen → null", () => {
  assert.equal(extractFromCells([cell("Total", "10.00"), cell("VAT", "1.50")], bankak, ctx), null);
});

// A synthetic screenshot: green background, white ruled rows, white "text" blocks on the right (label) and left (value).
function synthetic(rows) {
  const W = 400, H = 120 + rows * 70, data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, v) => { const i = (y * W + x) * 4; data[i] = data[i + 2] = v === 255 ? 255 : 40; data[i + 1] = v === 255 ? 255 : 140; data[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 0);
  for (let r = 0; r <= rows; r++) for (let x = 20; x < W - 20; x++) put(x, 100 + r * 70, 255);
  for (let r = 0; r < rows; r++) for (let y = 125 + r * 70; y < 145 + r * 70; y++) {
    for (let x = 250; x < 360; x += 3) put(x, y, 255);      // label
    for (let x = 40; x < 170; x += 3) put(x, y, 255);       // value
  }
  return { width: W, height: H, data };
}

await t("image: rules, cells and halves on a synthetic screen", () => {
  const img = synthetic(4);
  assert.equal(findRules(img).length, 5);
  const cells = findCells(img);
  assert.equal(cells.length, 4);
  for (const c of cells) {
    assert.ok(c.right.x >= 240 && c.right.x + c.right.w <= 370, JSON.stringify(c.right));
    assert.ok(c.left.x >= 30 && c.left.x + c.left.w <= 180, JSON.stringify(c.left));
  }
  const crop = prepCrop(img, cells[0].right, cells[0].bg, 2);
  assert.equal(crop.width, cells[0].right.w * 2);
  let min = 255; for (let i = 0; i < crop.data.length; i += 4) min = Math.min(min, crop.data[i]);
  assert.ok(crop.data[0] > 128 && min < 30, "background light, text dark");
});

await t("readImage: wires cells, labels and the double amount read", async () => {
  const img = synthetic(8);
  const cells = findCells(img), seq = english();
  let row = -1, side = 0;
  // Stub engine: answers per call order — label half first, then value; amount gets a second "eng" read.
  const calls = [];
  const ocr = async (crop, mode) => {
    calls.push(mode);
    if (mode === "num" || mode === "eng" && calls[calls.length - 2] === "num") return { text: seq[row].b.text, conf: 95 };
    if (side === 0) { row++; side = 1; return { text: seq[row].a.text, conf: 95 }; }
    side = 0; return { text: seq[row].b.text, conf: 95 };
  };
  const r = await readImage(img, ocr, [bankak], ctx);
  assert.equal(cells.length, 8);
  assert.equal(r.amount.value, "250000.00");
  assert.equal(r.status, "verified");
  assert.ok(calls.filter((m) => m === "num").length >= 5, "digit fields re-read in num mode");
});

console.log(`reader: ${n} passed`);
