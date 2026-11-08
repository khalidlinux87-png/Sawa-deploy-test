// Usage: node pfm/pfm-core.test.mjs
import assert from "node:assert/strict";
import * as P from "./pfm-core.mjs";

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

await t("toMinor parses without floats", () => {
  assert.equal(P.toMinor("1,234.5", "SDG"), 123450);
  assert.equal(P.toMinor("0.1", "USD") + P.toMinor("0.2", "USD"), 30);
  assert.equal(P.toMinor("١٢٣٫٤٥", "SDG"), 12345);       // Arabic-Indic digits and decimal mark
  assert.equal(P.toMinor("1.234", "OMR"), 1234);
  assert.throws(() => P.toMinor("1.005", "USD"), { code: "too_precise" });
  assert.throws(() => P.toMinor("abc", "USD"), { code: "bad_amount" });
  assert.equal(P.fromMinor(-12345, "SDG"), "-123.45");
});

await t("allocate sums exactly", () => {
  const parts = P.allocate(100, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b), 100);
  assert.deepEqual(parts, [34, 33, 33]);
  assert.deepEqual(P.allocate(0, [5, 5]), [0, 0]);
});

await t("invoice: line discount, invoice discount, mixed tax", () => {
  const r = P.computeInvoice([
    { description: "Design", qty: "10", unitPrice: 5000_00, taxRate: "15", discount: { type: "pct", rate: "10" } }, // 50,000 - 10% = 45,000
    { description: "Hosting", qty: "2.5", unitPrice: 1999 },                                          // 49.975 -> 49.98
  ], { currency: "SDG", invoiceDiscount: { type: "amt", minor: 1000_00 } });
  assert.equal(r.grossTotal, 5000000 + 4998);
  assert.equal(r.lines[0].lineDiscount, 500000); assert.equal(r.lines[0].amount, 4500000);
  assert.equal(r.subtotal, 4500000 + 4998);
  // 1,000.00 is spread in proportion over 4,500,000 and 4,998
  assert.deepEqual(r.lines.map((l) => l.invoiceDiscountShare), [99889, 111]);
  assert.equal(r.invoiceDiscount, 100000);
  assert.equal(r.netTotal, r.subtotal - r.invoiceDiscount);
  assert.equal(r.taxTotal, r.lines.reduce((a, l) => a + l.tax, 0));
  assert.equal(r.total, r.netTotal + r.taxTotal);
  assert.equal(r.lines[0].tax, Math.round(r.lines[0].net * 0.15));
  assert.deepEqual(r.taxBreakdown.map((b) => b.taxRate), ["15"]);
  assert.equal(r.amountDue, r.total);
});

await t("invoice: tax-inclusive prices extract tax exactly", () => {
  const r = P.computeInvoice([{ qty: "1", unitPrice: 115_00, taxRate: "15" }], { currency: "SAR", taxInclusive: true });
  assert.equal(r.netTotal, 100_00); assert.equal(r.taxTotal, 15_00); assert.equal(r.total, 115_00);
});

await t("invoice: discounts never go negative and inputs are validated", () => {
  const r = P.computeInvoice([{ qty: "1", unitPrice: 500, discount: { type: "amt", minor: 9999 } }], { currency: "USD" });
  assert.equal(r.total, 0);
  assert.throws(() => P.computeInvoice([{ qty: "0", unitPrice: 1 }], { currency: "USD" }), { code: "bad_qty" });
  assert.throws(() => P.computeInvoice([{ qty: "1", unitPrice: 1.5 }], { currency: "USD" }), { code: "bad_price" });
  assert.throws(() => P.computeInvoice([], { currency: "USD" }), { code: "bad_items" });
  assert.throws(() => P.computeInvoice([{ qty: "1", unitPrice: 1 }], { currency: "XXX" }), { code: "bad_currency" });
});

await t("invoice: large values stay exact", () => {
  const r = P.computeInvoice([{ qty: "999999.999", unitPrice: 9_000_000_000 }], { currency: "SDG" });
  assert.equal(r.total, 8999999991000000);
});

await t("status machine and payments", () => {
  P.assertTransition("draft", "sent");
  assert.throws(() => P.assertTransition("paid", "cancelled"), { code: "bad_transition" });
  assert.throws(() => P.assertTransition("draft", "paid"), { code: "bad_transition" });
  const inv = { status: "sent", total: 1000, amountPaid: 0 };
  const a = P.applyPayment(inv, 400); assert.deepEqual(a, { amountPaid: 400, amountDue: 600, status: "sent" });
  const b = P.applyPayment({ ...inv, ...a, status: "overdue" }, 600); assert.equal(b.status, "paid");
  assert.throws(() => P.applyPayment(inv, 1001), { code: "overpay" });
  assert.throws(() => P.applyPayment({ ...inv, status: "draft" }, 1), { code: "not_payable" });
  assert.equal(P.isOverdue({ status: "sent", dueDate: "2026-11-01" }, "2026-11-05"), true);
  assert.equal(P.isOverdue({ status: "paid", dueDate: "2026-11-01" }, "2026-11-05"), false);
});

await t("budget: thresholds, variance and pace", () => {
  const s = P.budgetStatus({ limit: 100000, alertsBp: [5000, 8000, 10000], firedBp: [5000] }, 82000, 15, 30);
  assert.equal(s.remaining, 18000); assert.equal(s.usedBp, 8200);
  assert.equal(s.expectedToDate, 50000); assert.equal(s.variance, 32000);
  assert.deepEqual(s.alerts.map((a) => a.kind + a.bp), ["threshold8000", "pace-1"]);
  const over = P.budgetStatus({ limit: 100000, firedBp: [5000, 8000] }, 120000, 20, 30);
  assert.equal(over.remaining, -20000);
  assert.deepEqual(over.alerts.map((a) => a.bp), [10000]);         // no pace alert once over the limit
  assert.equal(P.budgetStatus({ limit: 100000 }, 10000, 0, 30).alerts.length, 0);
});

await t("summary: transfers excluded, refunds net out, savings rate", () => {
  const s = P.summarize([
    { kind: "income", amount: 500000, categoryId: "salary" },
    { kind: "expense", amount: 120000, categoryId: "rent" },
    { kind: "expense", amount: 30000, categoryId: "food" },
    { kind: "income", amount: 10000, categoryId: "food", refundOf: "x" },
    { kind: "transfer", amount: 999999, categoryId: "c_internal" },
    { kind: "expense", amount: 5000, categoryId: "food", deleted: true },
  ]);
  assert.equal(s.income, 500000); assert.equal(s.expense, 140000); assert.equal(s.net, 360000);
  assert.equal(s.savingsRateBp, 7200);
  assert.deepEqual(s.byCategory.map((c) => c.categoryId), ["rent", "food", "salary"]);
  assert.equal(s.byCategory.find((c) => c.categoryId === "food").expense, 20000);
  assert.equal(P.summarize([]).savingsRateBp, null);
});

await t("wallet events map with stable ids and rules", () => {
  const rules = [{ type: "purchase", contains: "zain", categoryId: "telecom" }];
  const e = P.walletEventToTx({ walletTxId: "abc", type: "purchase", amount: -2500, currency: "SDG", at: "2026-11-05T10:00:00Z", counterpartyName: "Zain Sudan" }, rules);
  assert.equal(e.id, "w_abc"); assert.equal(e.kind, "expense"); assert.equal(e.amount, 2500);
  assert.equal(e.categoryId, "telecom"); assert.equal(e.autoCategorized, true);
  assert.equal(P.walletEventToTx({ walletTxId: "t1", type: "topup", amount: 1 }).kind, "transfer");
  assert.equal(P.walletEventToTx({ walletTxId: "r1", type: "refund", amount: 1, refundOf: "abc" }).refundOf, "w_abc");
  assert.equal(P.walletEventToTx({ walletTxId: "z", type: "unknown" }), null);
});

await t("audit chain detects tampering", async () => {
  const a = await P.auditEntry(null, { at: 1, actor: "u1", action: "tx.add", ref: "t1", after: { amount: 100 } });
  const b = await P.auditEntry(a, { at: 2, actor: "u1", action: "tx.update", ref: "t1", before: { amount: 100 }, after: { amount: 90 } });
  const c = await P.auditEntry(b, { at: 3, actor: "u1", action: "invoice.status", ref: "i1", after: { status: "sent" } });
  assert.equal((await P.verifyChain([a, b, c])).ok, true);
  const forged = { ...b, after: { amount: 9 } };
  assert.deepEqual(await P.verifyChain([a, forged, c]), { ok: false, at: 2, why: "hash" });
  assert.deepEqual(await P.verifyChain([a, c]), { ok: false, at: 3, why: "link" });
  assert.equal(P.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

await t("field encryption round-trips and is bound to the uid", async () => {
  const k1 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const s = await P.sealField("VAT 300123456700003", "uidA", k1);
  assert.match(s, /^v1:1:/);
  assert.equal(await P.openField(s, "uidA", { 1: k1 }), "VAT 300123456700003");
  await assert.rejects(P.openField(s, "uidB", { 1: k1 }));
  assert.notEqual(await P.sealField("x", "uidA", k1), await P.sealField("x", "uidA", k1)); // random IV
  assert.equal(await P.sealField(null, "uidA", k1), null);
});

await t("partial payments: allowed by default, issuer can turn them off", () => {
  const inv = { status: "sent", total: 1000, amountPaid: 0 };
  assert.equal(P.applyPayment(inv, 300).status, "sent");
  assert.throws(() => P.applyPayment({ ...inv, allowPartial: false }, 300), { code: "partial_not_allowed" });
  assert.equal(P.applyPayment({ ...inv, allowPartial: false }, 1000).status, "paid");
});

await t("invoice numbers reset each year, by local issue date", () => {
  assert.equal(P.invoiceNumber("INV", "2026-11-05", 42).number, "INV-2026-0042");
  assert.equal(P.invoiceNumber("INV", "2027-01-01", 1).number, "INV-2027-0001");
  assert.equal(P.invoiceNumber("INV", "2026-01-01", 12345).number, "INV-2026-12345");
  assert.throws(() => P.invoiceNumber("inv/x", "2026-01-01", 1), { code: "bad_prefix" });
  // 22:30 UTC on 31 Dec is already 1 Jan in Khartoum (UTC+2)
  assert.equal(P.localDate("Africa/Khartoum", new Date("2026-12-31T22:30:00Z")), "2027-01-01");
  assert.equal(P.localDate("America/New_York", new Date("2026-12-31T22:30:00Z")), "2026-12-31");
});

await t("tax policy follows the issuer's registration", () => {
  const settings = { taxRegistered: true, taxLabel: "GST", taxRates: [{ id: "std", label: "Standard", rate: "8.875" }] };
  const items = [{ qty: "1", unitPrice: 100 }, { qty: "1", unitPrice: 100, taxRate: "5" }, { qty: "1", unitPrice: 100, taxRateId: "std" }];
  const r = P.applyTaxPolicy(settings, items);
  assert.deepEqual(r.items.map((i) => i.taxRate), ["0", "5", "8.875"]);   // a blank rate stays 0: nothing is assumed
  assert.equal(r.taxLabel, "GST");
  assert.equal(P.applyTaxPolicy(settings, items, { taxLabel: "TVA" }).taxLabel, "TVA");
  assert.throws(() => P.applyTaxPolicy(settings, [{ qty: "1", unitPrice: 1, taxRateId: "nope" }]), { code: "bad_tax" });
  assert.throws(() => P.applyTaxPolicy({ taxRegistered: false }, items), { code: "tax_not_registered" });
  assert.throws(() => P.applyTaxPolicy({ taxRegistered: false }, [{ qty: "1", unitPrice: 1 }], { taxInclusive: true }), { code: "tax_not_registered" });
  assert.equal(P.applyTaxPolicy({ taxRegistered: false }, [{ qty: "1", unitPrice: 1, taxRate: "0" }]).items[0].taxRate, "0");
  const inv = P.computeInvoice(r.items, { currency: "USD" });
  assert.equal(inv.taxTotal, 0 + 5 + 9);                                   // 8.875 % of 1.00 = 0.08875 -> 0.09
  assert.deepEqual(inv.taxBreakdown.map((b) => b.taxRate), ["5", "8.875"]);
});

await t("receiving accounts are validated", () => {
  const bank = P.validatePayoutAccount({ type: "bank", label: "Main", holderName: "Khalid", bankName: "Bank of Khartoum", number: "1234 5678 9012" });
  assert.equal(bank.number, "123456789012");
  assert.equal(P.validatePayoutAccount({ type: "bank", label: "EU", holderName: "K", bankName: "X", number: "GB82 WEST 1234 5698 7654 32" }).number, "GB82WEST12345698765432");
  assert.throws(() => P.validatePayoutAccount({ type: "bank", label: "EU", holderName: "K", bankName: "X", number: "GB00WEST12345698765432" }), { code: "bad_account" });
  assert.equal(P.validatePayoutAccount({ type: "mobile_money", label: "Bankak", holderName: "K", provider: "Bankak", number: "+249912345678" }).number, "+249912345678");
  assert.throws(() => P.validatePayoutAccount({ type: "mobile_money", label: "x", holderName: "K", provider: "p", number: "abc" }), { code: "bad_account" });
  assert.throws(() => P.validatePayoutAccount({ type: "crypto" }), { code: "bad_account" });
  assert.equal(P.maskNumber("123456789012"), "•••• 9012");
});

await t("logo check sniffs bytes and refuses SVG", () => {
  const png = new Uint8Array(64); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(P.sniffLogo(png), "image/png");
  const jpg = new Uint8Array(64); jpg.set([0xff, 0xd8, 0xff]); assert.equal(P.sniffLogo(jpg), "image/jpeg");
  assert.throws(() => P.sniffLogo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), { code: "bad_logo" });
  assert.throws(() => P.sniffLogo(new Uint8Array(600 * 1024).fill(0x89)), { code: "bad_logo" });
});

await t("allowed currencies only, decimals from Intl", () => {
  assert.deepEqual([...P.ALLOWED_CURRENCIES].sort(), ["AED", "CAD", "CNY", "EGP", "GBP", "OMR", "QAR", "SAR", "SDG", "USD"]);
  assert.equal(P.currencyExp("USD"), 2); assert.equal(P.currencyExp("OMR"), 3); assert.equal(P.currencyExp("SDG"), 2);
  assert.equal(P.currencyExp("CNY"), 2); assert.equal(P.currencyExp("EGP"), 2); assert.equal(P.currencyExp("CAD"), 2);
  assert.equal(P.toMinor("15.00", "CNY"), 1500); assert.throws(() => P.toMinor("1.555", "CNY"), { code: "too_precise" });
  for (const c of ["JPY", "EUR", "KWD", "INR", "XXQ", "usd", "XXX"]) assert.throws(() => P.currencyExp(c), { code: "bad_currency" }, c);
  const r = P.computeInvoice([{ qty: "3", unitPrice: 1250, taxRate: "10" }], { currency: "CNY" });
  assert.equal(r.total, 4125);
});

await t("typed rates: any precision up to 4 decimals, 0 to 100 %", () => {
  assert.equal(P.toRate("15"), 150000n); assert.equal(P.toRate("8.875"), 88750n); assert.equal(P.toRate("٧٫٥"), 75000n);
  assert.equal(P.rateText(88750n), "8.875"); assert.equal(P.rateText(150000n), "15");
  for (const bad of ["101", "-1", "abc", "1.23456", ""]) assert.throws(() => P.toRate(bad), { code: "bad_rate" });
  const d = P.computeInvoice([{ qty: "1", unitPrice: 10000, discount: { type: "pct", rate: "12.5" } }], { currency: "GBP" });
  assert.equal(d.subtotal, 8750);
});

await t("currency conversion is exact across decimal places", () => {
  assert.equal(P.convert(100_00, "USD", "SAR", "3.75"), 375_00);
  assert.equal(P.convert(100_00, "USD", "CNY", "7.123"), 71230);           // 712.30 CNY
  assert.equal(P.convert(1_000_00, "CNY", "USD", "0.1384"), 13840);        // 1000.00 CNY = 138.40 USD
  assert.equal(P.convert(1_000_00, "USD", "OMR", "0.3071"), 307_100);       // 3 decimals
  assert.equal(P.convert(5, "GBP", "GBP", "9"), 5);
  assert.equal(P.convert(9_000_000_000_00, "USD", "SDG", "600.123456"), 540111110400000);
  assert.throws(() => P.convert(1, "USD", "GBP", "0"), { code: "bad_fx_rate" });
  assert.throws(() => P.convert(1, "USD", "GBP", "-1"), { code: "bad_fx_rate" });
});

await t("summary in base currency, with a per-currency view", () => {
  const s = P.summarize([
    { kind: "income", amount: 1000_00, currency: "USD", baseAmount: 3750_00, categoryId: "salary" },
    { kind: "expense", amount: 500_00, currency: "SAR", baseAmount: 500_00, categoryId: "rent" },
    { kind: "expense", amount: 20_00, currency: "GBP", baseAmount: 81_50, categoryId: "food" },
  ]);
  assert.equal(s.income, 3750_00); assert.equal(s.expense, 581_50);
  assert.deepEqual(s.byCurrency.map((c) => c.currency).sort(), ["GBP", "SAR", "USD"]);
});

await t("receiving accounts carry a currency and filter per invoice", () => {
  const usd = { id: "a", ...P.validatePayoutAccount({ type: "bank", currency: "USD", label: "US", holderName: "K", bankName: "Chase", number: "000123456789" }) };
  const eur = { id: "b", ...P.validatePayoutAccount({ type: "bank", currency: "GBP", label: "EU", holderName: "K", bankName: "X", number: "DE89370400440532013000" }) };
  const w = { id: "w", ...P.validatePayoutAccount({ type: "sawa_wallet" }) };
  assert.deepEqual(P.accountsForInvoice([usd, eur, w], ["a", "b", "w"], "GBP").map((a) => a.id), ["b", "w"]);
  assert.throws(() => P.validatePayoutAccount({ type: "bank", currency: "ZZZ", label: "x", holderName: "K", bankName: "X", number: "123456" }), { code: "bad_account" });
});

await t("pay page options follow the switches", () => {
  const accts = [{ id: "w", type: "sawa_wallet", currency: "ANY" }, { id: "b", type: "bank", currency: "GBP" },
                 { id: "c", type: "bank", currency: "GBP", cardPayout: { status: "active" } }];
  const inv = { status: "sent", amountDue: 100, currency: "GBP", payoutAccountIds: ["w", "b"] };
  const bal = { GBP: 50, USD: 900, SAR: 0 };
  // Today: every switch off, so transfer is the only way to pay
  assert.deepEqual(P.payOptions(inv, accts, {}, bal), { methods: ["transfer"], walletFrom: [] });
  assert.deepEqual(P.payOptions(inv, accts, { wallet: true }, bal), { methods: ["wallet", "transfer"], walletFrom: ["GBP"] });
  assert.deepEqual(P.payOptions(inv, accts, { wallet: true, card: true, fxQuotes: true }, bal), { methods: ["wallet", "transfer", "card"], walletFrom: ["GBP", "USD"] });
  // fxQuotes without the wallet does nothing
  assert.deepEqual(P.payOptions(inv, accts, { fxQuotes: true }, bal).walletFrom, []);
  // card switched on, but no bank account onboarded with the provider: no card button
  assert.deepEqual(P.payOptions(inv, accts.slice(0, 2), { wallet: true, card: true }).methods, ["wallet", "transfer"]);
  // only the wallet account chosen, and the wallet is off: nothing to pay with, so the issuer is warned at send time
  assert.deepEqual(P.payOptions({ ...inv, payoutAccountIds: ["w"] }, accts, {}).methods, []);
  assert.deepEqual(P.payOptions({ ...inv, status: "paid" }, accts, {}).methods, []);
});

await t("rows without a rate stay out of base totals", () => {
  const s = P.summarize([
    { kind: "income", amount: 1000_00, currency: "GBP", categoryId: "salary" },
    { kind: "expense", amount: 50_00, currency: "USD", categoryId: "food" },               // rate pending
    { kind: "expense", amount: 20_00, currency: "USD", baseAmount: 18_45, categoryId: "food" },
  ], { base: "GBP" });
  assert.equal(s.expense, 18_45); assert.equal(s.ratePending, 1);
  assert.equal(s.byCurrency.find((c) => c.currency === "USD").expense, 70_00);
});

await t("budget months honour the start day", () => {
  assert.equal(P.budgetMonth("2026-11-05"), "2026-11");
  assert.equal(P.budgetMonth("2026-11-24", 25), "2026-10"); assert.equal(P.budgetMonth("2026-11-25", 25), "2026-11");
  assert.equal(P.budgetMonth("2026-01-10", 25), "2025-12");
  assert.equal(P.budgetMonth("2026-02-28", 31), "2026-02");   // Feb has no 31st: starts on the 28th
  assert.equal(P.budgetMonth("2026-02-27", 31), "2026-01");
  assert.throws(() => P.budgetMonth("2026-02-30"), { code: "bad_date" });
});

await t("rollup contributions and edit diffs", () => {
  const a = { kind: "expense", baseAmount: 500, categoryId: "c_food", month: "2026-11", date: "2026-11-05" };
  assert.deepEqual(P.rollupDiff(null, a), { "2026-11": [["txCount", 1], ["expense", 500], ["cat.c_food.e", 500], ["cat.c_food.n", 1], ["day.d05.e", 500]] });
  // amount change only touches the money fields
  assert.deepEqual(P.rollupDiff(a, { ...a, baseAmount: 700 }), { "2026-11": [["expense", 200], ["cat.c_food.e", 200], ["day.d05.e", 200]] });
  // moved to another month and category
  const moved = P.rollupDiff(a, { ...a, categoryId: "c_rent", month: "2026-10", date: "2026-10-30" });
  assert.deepEqual(Object.keys(moved).sort(), ["2026-10", "2026-11"]);
  assert.ok(moved["2026-11"].some(([f, v]) => f === "expense" && v === -500));
  // delete reverses everything; a rate-pending row only counts as pending
  assert.deepEqual(P.rollupDiff(a, { ...a, deleted: true })["2026-11"].find(([f]) => f === "txCount"), ["txCount", -1]);
  assert.deepEqual(P.rollupDiff(null, { ...a, baseAmount: null }), { "2026-11": [["txCount", 1], ["ratePending", 1]] });
  assert.deepEqual(P.rollupDiff(null, { ...a, status: "suggested" }), {});
  assert.throws(() => P.rollupContrib({ ...a, categoryId: "c.food" }), { code: "bad_category" });
  assert.equal(new Set(P.DEFAULT_CATEGORIES.map((c) => c.id)).size, P.DEFAULT_CATEGORIES.length);
});

await t("budget periods and elapsed days", () => {
  assert.deepEqual(P.budgetPeriod("2026-11"), { start: "2026-11-01", end: "2026-11-30", days: 30 });
  assert.deepEqual(P.budgetPeriod("2026-11", 25), { start: "2026-11-25", end: "2026-12-24", days: 30 });
  assert.deepEqual(P.budgetPeriod("2026-01", 31), { start: "2026-01-31", end: "2026-02-27", days: 28 });
  assert.deepEqual(P.budgetPeriod("2026-12", 25), { start: "2026-12-25", end: "2027-01-24", days: 31 });
  const p = P.budgetPeriod("2026-11");
  assert.equal(P.periodElapsed(p, "2026-11-06"), 6); assert.equal(P.periodElapsed(p, "2026-10-01"), 0); assert.equal(P.periodElapsed(p, "2027-01-01"), 30);
});

await t("recurring rules: first, next, catch-up, month ends", () => {
  const rent = { freq: "monthly", day: 1 };
  assert.equal(P.firstOccurrence(rent, "2026-11-01"), "2026-11-01");
  assert.equal(P.firstOccurrence(rent, "2026-11-02"), "2026-12-01");
  assert.equal(P.nextOccurrence(rent, "2026-12-01"), "2027-01-01");
  const eom = { freq: "monthly", day: 31 };
  assert.equal(P.nextOccurrence(eom, "2026-01-31"), "2026-02-28");
  assert.equal(P.nextOccurrence(eom, "2026-02-28"), "2026-03-31");   // day 31 stays the rule, not 28
  assert.equal(P.nextOccurrence({ freq: "monthly", day: 15, interval: 3 }, "2026-11-15"), "2027-02-15");
  assert.equal(P.firstOccurrence({ freq: "weekly", weekday: 5 }, "2026-11-06"), "2026-11-06");   // 6 Nov 2026 is a Friday
  assert.equal(P.firstOccurrence({ freq: "weekly", weekday: 0 }, "2026-11-06"), "2026-11-08");
  assert.equal(P.nextOccurrence({ freq: "weekly", weekday: 0, interval: 2 }, "2026-11-08"), "2026-11-22");
  assert.equal(P.nextOccurrence({ freq: "yearly", month: 2, day: 29 }, "2028-02-29"), "2029-02-28");
  const due = P.dueOccurrences(rent, "2026-08-01", "2026-11-06");
  assert.deepEqual(due.dates, ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"]); assert.equal(due.next, "2026-12-01");
  assert.deepEqual(P.dueOccurrences(rent, "2026-08-01", "2026-11-06", "2026-09-15"), { dates: ["2026-08-01", "2026-09-01"], next: "2026-10-01", ended: true });
  assert.equal(P.dueOccurrences(rent, "2020-01-01", "2026-11-06").dates.length, 12);
  for (const bad of [null, { freq: "daily" }, { freq: "monthly", day: 0 }, { freq: "weekly", weekday: 7 }, { freq: "monthly", day: 1, interval: 13 }])
    assert.throws(() => P.checkRule(bad), { code: "bad_rule" });
});

await t("rules match through Arabic spelling variants, longest wins", () => {
  const rules = [{ id: "a", contains: "uber", categoryId: "c_transport" }, { id: "b", contains: "Uber Eats", categoryId: "c_food" },
    { id: "c", contains: "مكتبة جرير", categoryId: "c_education", kind: "expense" }, { id: "d", contains: "راتب", categoryId: "c_salary", kind: "income" }];
  assert.equal(P.matchCategoryRule(rules, { kind: "expense", counterparty: "UBER *TRIP" }).categoryId, "c_transport");
  assert.equal(P.matchCategoryRule(rules, { kind: "expense", counterparty: "Uber Eats" }).categoryId, "c_food");
  assert.equal(P.matchCategoryRule(rules, { kind: "expense", counterparty: "مَكتَبة جَرِير" }).categoryId, "c_education");   // diacritics
  assert.equal(P.matchCategoryRule(rules, { kind: "expense", note: "راتب" }), null);                                         // kind must agree
  assert.equal(P.matchCategoryRule(rules, { kind: "income", note: "راتب شهر نوفمبر" }).categoryId, "c_salary");
  assert.equal(P.normText("أحمد إلى مكّة"), P.normText("احمد الي مكه"));
  assert.equal(P.matchCategoryRule(rules, { kind: "expense", counterparty: "" }), null);
});

console.log(process.exitCode ? "FAILED" : `pfm-core: ${n} passed`);
