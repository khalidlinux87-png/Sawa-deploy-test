// Sawa Personal Accountant: pure logic (no I/O). Runs in the Worker and in Node tests.
// Every amount is an integer in the currency's minor unit (SDG 1.00 = 100).
// Floats never touch money. Products of quantity and price use BigInt.

// The currencies Sawa accepts: Sudanese pound, US dollar, Chinese yuan, Qatari riyal, Saudi riyal,
// UAE dirham, pound sterling, Canadian dollar, Omani riyal, Egyptian pound, Kuwaiti dinar, Japanese yen.
// Nothing else is accepted. The number of decimals comes from Intl (CLDR): JPY 0, OMR and KWD 3, the rest 2.
// EXP_OVERRIDE pins a currency if the product needs a different number of decimals than CLDR, and must never
// change once money is stored in it. Adding a currency here also needs it in the app's list (app.p9.js CURS).
export const ALLOWED_CURRENCIES = Object.freeze(["SDG", "USD", "CNY", "QAR", "SAR", "AED", "GBP", "CAD", "OMR", "EGP", "KWD", "JPY"]);
const EXP_OVERRIDE = {};
const CUR_SET = new Set(ALLOWED_CURRENCIES);
const expCache = new Map();
export function currencyExp(cur) {
  if (typeof cur !== "string" || !/^[A-Z]{3}$/.test(cur) || (CUR_SET.size && !CUR_SET.has(cur))) throw new PfmError("bad_currency", String(cur));
  if (EXP_OVERRIDE[cur] != null) return EXP_OVERRIDE[cur];
  let e = expCache.get(cur);
  if (e == null) { e = new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits; expCache.set(cur, e); }
  return e;
}
export const isCurrency = (c) => { try { currencyExp(c); return true; } catch { return false; } };

const BP = 10000n;            // basis points (budgets and analytics): 1500 = 15.00 %
const PPM = 1000000n;         // rates typed by users (tax, % discounts): parts per million, so "8.875" % = 88750
const QTY_SCALE = 1000n;      // quantities carry 3 decimals: "2.5" -> 2500

export class PfmError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

// ---------- parsing and formatting ----------

// Parses "1,234.5" to a minor-unit integer without floats. Rejects excess precision.
export function toMinor(input, currency) {
  const exp = currencyExp(currency);
  const s = String(input).replace(/[,\s٬]/g, "").replace(/٫/g, ".")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const m = /^(-)?(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) throw new PfmError("bad_amount", String(input));
  const frac = m[3] || "";
  if (frac.length > exp) throw new PfmError("too_precise", String(input));
  const v = Number(m[2]) * 10 ** exp + Number(frac.padEnd(exp, "0") || 0);
  if (!Number.isSafeInteger(v)) throw new PfmError("too_large", String(input));
  return m[1] ? -v : v;
}

// A percentage the user typed, as text: "15", "7.5", "8.875", "0". Up to 4 decimals, 0 to 100.
// Returns parts per million as BigInt. No rate is ever assumed: the issuer types it.
export function toRate(input) {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(String(input ?? "").trim().replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace("\u066B", "."));
  if (!m) throw new PfmError("bad_rate", String(input));
  const v = BigInt(m[1]) * 10000n + BigInt((m[2] || "").padEnd(4, "0"));
  if (v > PPM) throw new PfmError("bad_rate", String(input));
  return v;
}
// Canonical text for a rate: 88750n -> "8.875"
export const rateText = (ppm) => { const w = ppm / 10000n, f = String(ppm % 10000n).padStart(4, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : String(w); };

// ---------- currency conversion ----------

// rate: text, how many units of `to` one unit of `from` buys ("0.2667", "3.75", "600.5").
// Exact: BigInt throughout, rounded once, half away from zero. Handles different decimal places (USD 2 -> JPY 0 -> KWD 3).
export function convert(minor, from, to, rate) {
  if (from === to) return minor;
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(String(rate));
  if (!m || /^0*(\.0*)?$/.test(rate)) throw new PfmError("bad_fx_rate", String(rate));
  const scale = 10n ** BigInt((m[2] || "").length);
  const r = BigInt(m[1] + (m[2] || ""));
  const ef = currencyExp(from), et = currencyExp(to);
  let numr = big(minor) * r, den = scale;
  if (et >= ef) numr *= 10n ** BigInt(et - ef); else den *= 10n ** BigInt(ef - et);
  return num(divRound(numr, den));
}

export function fromMinor(minor, currency) {
  const exp = currencyExp(currency);
  const neg = minor < 0, a = Math.abs(minor);
  const p = 10 ** exp, whole = Math.floor(a / p), frac = String(a % p).padStart(exp, "0");
  return (neg ? "-" : "") + whole + (exp ? "." + frac : "");
}

export function toQty(input) {
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(String(input).trim());
  if (!m) throw new PfmError("bad_qty", String(input));
  const q = BigInt(m[1]) * QTY_SCALE + BigInt((m[2] || "").padEnd(3, "0"));
  if (q === 0n) throw new PfmError("bad_qty", "quantity must be > 0");
  return q;
}

// Rounds the quotient num/den half away from zero. BigInt in, BigInt out.
function divRound(num, den) {
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num, d = den < 0n ? -den : den;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}
const big = (x) => BigInt(x);
const num = (x) => {
  const v = Number(x);
  if (!Number.isSafeInteger(v)) throw new PfmError("too_large");
  return v;
};

// Splits `total` across `weights` in proportion, so the parts sum exactly to `total`
// (largest-remainder method). Used to spread an invoice-level discount over the lines.
export function allocate(total, weights) {
  const T = big(total), W = weights.map(big), sum = W.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0);
  const base = W.map((w) => (T * w) / sum);
  let left = T - base.reduce((a, b) => a + b, 0n);
  const order = W.map((w, i) => [((T * w) % sum), i]).sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : a[1] - b[1]));
  for (let k = 0; left > 0n; k++, left--) base[order[k][1]] += 1n;
  return base.map(num);
}

// ---------- invoice totals ----------

/**
 * items: [{ description, qty: "2.5", unitPrice: minor, discount?: {type:"pct",rate:"10"}|{type:"amt",minor}, taxRate?: "15" }]
 *        taxRate is whatever the issuer typed (a percentage as text). Missing = no tax on that line.
 * opts:  { currency, invoiceDiscount?: {type,rate|minor}, taxInclusive?: false, amountPaid?: 0 }
 * Discounts apply before tax. Tax is computed per line, then summed per rate.
 */
export function computeInvoice(items, opts) {
  const { currency, invoiceDiscount = null, taxInclusive = false, amountPaid = 0 } = opts;
  currencyExp(currency);
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) throw new PfmError("bad_items");

  const lines = items.map((it, i) => {
    if (!Number.isSafeInteger(it.unitPrice) || it.unitPrice < 0) throw new PfmError("bad_price", "line " + (i + 1));
    let taxPpm;
    try { taxPpm = it.taxRate == null || it.taxRate === "" ? 0n : toRate(it.taxRate); } catch { throw new PfmError("bad_tax", "line " + (i + 1)); }
    const qty = toQty(it.qty);
    const gross = divRound(big(it.unitPrice) * qty, QTY_SCALE);
    const lineDisc = discountOf(gross, it.discount);
    return { i, qty, taxPpm, gross, lineDisc };
  });

  // Invoice-level discount is computed on the post-line-discount amount and spread over the lines.
  const afterLine = lines.map((l) => l.gross - l.lineDisc);
  const afterLineSum = afterLine.reduce((a, b) => a + b, 0n);
  const invDisc = discountOf(afterLineSum, invoiceDiscount);
  const shares = allocate(num(invDisc), afterLine.map(num)).map(big);

  const byRate = new Map();
  let grossTotal = 0n, lineDiscountTotal = 0n, netTotal = 0n, taxTotal = 0n;
  const outLines = lines.map((l, k) => {
    const disc = l.lineDisc + shares[k];
    const afterDisc = l.gross - disc;
    let net, tax;
    if (taxInclusive) {                       // price already contains tax: extract it
      net = divRound(afterDisc * PPM, PPM + l.taxPpm);
      tax = afterDisc - net;
    } else {
      net = afterDisc;
      tax = divRound(net * l.taxPpm, PPM);
    }
    grossTotal += l.gross; lineDiscountTotal += l.lineDisc; netTotal += net; taxTotal += tax;
    const key = String(l.taxPpm);
    const r = byRate.get(key) || { ppm: l.taxPpm, taxable: 0n, tax: 0n };
    r.taxable += net; r.tax += tax; byRate.set(key, r);
    // amount: what the row shows (after its own discount, before tax and the invoice-wide discount).
    // invoiceDiscountShare, net and tax: the basis that the tax is computed on.
    return { index: l.i, qtyMilli: num(l.qty), gross: num(l.gross), lineDiscount: num(l.lineDisc), amount: num(l.gross - l.lineDisc),
      invoiceDiscountShare: num(shares[k]), net: num(net), taxRate: rateText(l.taxPpm), tax: num(tax), total: num(net + tax) };
  });

  const total = netTotal + taxTotal;
  const paid = big(amountPaid);
  return {
    currency, lines: outLines,
    grossTotal: num(grossTotal), lineDiscountTotal: num(lineDiscountTotal),
    subtotal: num(grossTotal - lineDiscountTotal),      // sum of row amounts
    invoiceDiscount: num(invDisc), netTotal: num(netTotal),
    taxTotal: num(taxTotal), total: num(total),
    taxBreakdown: [...byRate.values()].filter((r) => r.ppm > 0n)
      .sort((a, b) => (a.ppm < b.ppm ? -1 : 1)).map((r) => ({ taxRate: rateText(r.ppm), taxable: num(r.taxable), tax: num(r.tax) })),
    amountPaid: num(paid), amountDue: num(total - paid > 0n ? total - paid : 0n),
  };
}

function discountOf(base, d) {
  if (!d) return 0n;
  let v;
  if (d.type === "pct") {
    let ppm; try { ppm = toRate(d.rate); } catch { throw new PfmError("bad_discount"); }
    v = divRound(base * ppm, PPM);
  } else if (d.type === "amt") {
    if (!Number.isSafeInteger(d.minor) || d.minor < 0) throw new PfmError("bad_discount");
    v = big(d.minor);
  } else throw new PfmError("bad_discount");
  return v > base ? base : v;               // a discount never takes a line below zero
}

// ---------- invoice status machine ----------

export const INVOICE_TRANSITIONS = {
  draft: ["sent", "cancelled"],
  sent: ["paid", "overdue", "cancelled"],
  overdue: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

export function assertTransition(from, to) {
  if (!(INVOICE_TRANSITIONS[from] || []).includes(to)) throw new PfmError("bad_transition", from + " -> " + to);
}

// Applies one payment. A partial payment keeps the invoice sent/overdue; the last one marks it paid.
// Partial payments are allowed unless the issuer turned them off for this invoice (allowPartial: false).
export function applyPayment(inv, amount) {
  if (!["sent", "overdue"].includes(inv.status)) throw new PfmError("not_payable", inv.status);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PfmError("bad_amount");
  const due = inv.total - inv.amountPaid;
  if (amount > due) throw new PfmError("overpay", "due " + due);
  if (inv.allowPartial === false && amount !== due) throw new PfmError("partial_not_allowed", "due " + due);
  const amountPaid = inv.amountPaid + amount;
  return { amountPaid, amountDue: inv.total - amountPaid, status: amountPaid === inv.total ? "paid" : inv.status };
}

// What the money on an invoice looks like, for display (C287). Derived, never stored, so it cannot drift from the
// amounts: amountPaid is confirmed money, claimedAmount is what payers reported and the issuer has not checked yet.
//   paid                  everything confirmed
//   pending_verification  confirmed + reported covers the total ("Paid — pending verification")
//   partially_paid        some money confirmed or reported, not the total
//   unpaid                nothing yet
// draft and cancelled invoices have no pay state (null).
export const PAY_STATES = Object.freeze(["unpaid", "partially_paid", "pending_verification", "paid"]);
export function payState(inv) {
  if (!inv || inv.status === "draft" || inv.status === "cancelled") return null;
  const total = inv.total ?? inv.totals?.total ?? 0, paid = inv.amountPaid || 0, claimed = Math.max(0, inv.claimedAmount || 0);
  if (inv.status === "paid" || (total > 0 && paid >= total)) return "paid";
  if (claimed > 0 && paid + claimed >= total) return "pending_verification";
  if (paid > 0 || claimed > 0) return "partially_paid";
  return "unpaid";
}

// A file by its bytes: the photo types plus PDF. Used for payment proofs and project attachments.
export const FILE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
export function sniffFile(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length < 16) throw new PfmError("bad_file", "empty");
  // "%PDF-" at the start (some writers put a few junk bytes first; the spec allows up to 1024)
  const head = Math.min(u8.length - 5, 1024);
  for (let i = 0; i <= head; i++) if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) return "application/pdf";
  const h = (i, ...b) => b.every((x, k) => u8[i + k] === x);
  if (h(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (h(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (h(0, 0x52, 0x49, 0x46, 0x46) && h(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  throw new PfmError("bad_file", "type");
}

// ---------- invoice numbers (one sequence per issuer, reset every year) ----------

// The year comes from the issue date in the issuer's time zone, so an invoice issued
// on 31 Dec local time is numbered in that year even if it is already January in UTC.
export function invoiceNumber(prefix, issueDate, seq) {
  const y = /^(\d{4})-\d{2}-\d{2}$/.exec(issueDate);
  if (!y) throw new PfmError("bad_date", issueDate);
  if (!/^[A-Z0-9]{1,8}$/.test(prefix)) throw new PfmError("bad_prefix", prefix);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new PfmError("bad_seq");
  return { year: y[1], number: `${prefix}-${y[1]}-${String(seq).padStart(4, "0")}` };
}

// Today's date as "YYYY-MM-DD" in an IANA time zone. Used for issue dates and the overdue sweep.
export function localDate(tz, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// ---------- tax policy ----------

// Tax is never looked up by country. A tax-registered issuer types the rate (per line, or picks one of
// their own saved rates, settings.taxRates: [{id, label, rate}]) and names the tax ("VAT", "GST", "TVA", ...).
// An issuer who is not tax-registered cannot charge tax: the editor hides the fields, and the server
// rejects tax that arrives anyway (a client bug or a crafted request).
export function applyTaxPolicy(settings, items, opts = {}) {
  const has = (it) => (it.taxRate != null && it.taxRate !== "" && toRate(it.taxRate) > 0n) || it.taxRateId;
  if (!settings.taxRegistered) {
    if (items.some(has) || opts.taxInclusive) throw new PfmError("tax_not_registered");
    return { items: items.map(({ taxRateId, ...it }) => ({ ...it, taxRate: "0" })), taxInclusive: false, taxLabel: null };
  }
  const saved = new Map((settings.taxRates || []).map((r) => [r.id, r]));
  const out = items.map(({ taxRateId, ...it }) => {
    if (taxRateId) {
      const r = saved.get(taxRateId);
      if (!r) throw new PfmError("bad_tax", "unknown saved rate " + taxRateId);
      return { ...it, taxRate: rateText(toRate(r.rate)) };
    }
    return { ...it, taxRate: rateText(toRate(it.taxRate ?? "0")) };   // empty = 0: nothing is assumed
  });
  const label = String(opts.taxLabel ?? settings.taxLabel ?? "").trim().slice(0, 24) || null;   // null: the template says "Tax"
  return { items: out, taxInclusive: !!opts.taxInclusive, taxLabel: label };
}

// ---------- receiving accounts ----------

// Where the issuer can be paid besides Sawa Wallet. Bank and mobile-money numbers are
// stored encrypted and printed on the invoice only when the issuer selects that account.
export const PAYOUT_TYPES = ["sawa_wallet", "bank", "mobile_money", "other"];
export function validatePayoutAccount(a) {
  const t = (s, max) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
  if (!PAYOUT_TYPES.includes(a.type)) throw new PfmError("bad_account", "type");
  // Each account receives one currency. "ANY" is for accounts that convert on arrival (e.g. some wallets).
  const currency = a.currency ?? "ANY";
  if (currency !== "ANY" && !isCurrency(currency)) throw new PfmError("bad_account", "currency");
  if (a.type === "sawa_wallet") return { type: a.type, label: a.label || "Sawa Wallet", currency: "ANY" };
  if (!t(a.label, 40)) throw new PfmError("bad_account", "label");
  if (!t(a.holderName, 80)) throw new PfmError("bad_account", "holderName");
  const number = String(a.number || "").replace(/[\s-]/g, "");
  if (a.type === "bank") {
    if (!t(a.bankName, 60)) throw new PfmError("bad_account", "bankName");
    if (!/^[A-Z0-9]{6,34}$/i.test(number)) throw new PfmError("bad_account", "number");
    if (/^[A-Z]{2}\d{2}/i.test(number) && !ibanOk(number)) throw new PfmError("bad_account", "iban");
  } else if (a.type === "mobile_money") {
    if (!t(a.provider, 40)) throw new PfmError("bad_account", "provider");
    if (!/^\+?\d{6,15}$/.test(number)) throw new PfmError("bad_account", "number");
  } else if (!t(a.details, 200)) throw new PfmError("bad_account", "details");
  return { type: a.type, currency, label: a.label.trim(), holderName: a.holderName.trim(), bankName: a.bankName?.trim(),
    provider: a.provider?.trim(), number: number.toUpperCase() || undefined, branch: a.branch?.trim(), details: a.details?.trim() };
}
// ISO 13616 mod-97 check.
function ibanOk(iban) {
  const r = (iban.slice(4) + iban.slice(0, 4)).toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0; for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}
// Accounts to print on an invoice: those the issuer picked that take the invoice's currency.
export const accountsForInvoice = (accounts, ids, currency) =>
  ids.map((id) => accounts.find((a) => a.id === id)).filter((a) => a && !a.archived && (a.currency === "ANY" || a.currency === currency));

// ---------- what the pay page offers ----------

// Feature switches (Worker env), all off until the product decides:
//   wallet:   paying from a Sawa Wallet balance. Needs the server-side wallet ledger (deferred).
//   card:     card checkout. Needs a provider; the money settles straight to the issuer's bank account,
//             so it is offered only if the issuer has a bank account onboarded with that provider.
//   fxQuotes: paying an invoice from a wallet balance in another currency. Needs an FX source and margin policy.
export function payOptions(inv, accounts, flags = {}, payerBalances = null) {
  const open = (inv.status === "sent" || inv.status === "overdue") && inv.amountDue > 0;
  if (!open) return { methods: [], walletFrom: [] };
  const shown = accountsForInvoice(accounts, inv.payoutAccountIds || [], inv.currency);
  const methods = flags.wallet ? ["wallet"] : [];                // Sawa users; guests are asked to sign in first
  if (shown.some((a) => a.type !== "sawa_wallet")) methods.push("transfer");
  if (flags.card && accounts.some((a) => a.type === "bank" && !a.archived && a.cardPayout?.status === "active")) methods.push("card");
  // Which of the payer's balances can pay: the invoice currency, plus others only when quotes are on.
  const walletFrom = flags.wallet && payerBalances
    ? Object.keys(payerBalances).filter((c) => payerBalances[c] > 0 && (c === inv.currency || flags.fxQuotes))
    : [];
  return { methods, walletFrom };
}

// For lists and previews: "•••• 4321".
export const maskNumber = (n) => (n && n.length > 4 ? "•••• " + n.slice(-4) : n || "");

// ---------- logo upload check ----------

// Accepts PNG, JPEG or WebP up to 512 KB, judged by the file's bytes and not its name.
// SVG is refused: it can carry script. Returns the real content type.
export function sniffLogo(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length < 16) throw new PfmError("bad_logo", "empty");
  if (u8.length > 512 * 1024) throw new PfmError("bad_logo", "too_big");
  const h = (i, ...b) => b.every((x, k) => u8[i + k] === x);
  if (h(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (h(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (h(0, 0x52, 0x49, 0x46, 0x46) && h(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  throw new PfmError("bad_logo", "type");
}

// The cron calls this. dueDate and today are "YYYY-MM-DD" in the issuer's time zone.
export const isOverdue = (inv, today) => inv.status === "sent" && inv.dueDate < today;

// ---------- budgets ----------

/**
 * Budget for one category and one period.
 * budget: { limit, alertsBp: [5000, 8000, 10000], firedBp: [] }
 * spent: minor units spent in the period so far. Refunds are already netted out.
 * elapsed and length: days into the period and its length in days.
 */
export function budgetStatus(budget, spent, elapsed, length) {
  const limit = budget.limit;
  const usedBp = limit > 0 ? Number(divRound(big(spent) * BP, big(limit))) : (spent > 0 ? 10001 : 0);
  const frac = Math.min(Math.max(elapsed / length, 0), 1);
  const expectedToDate = Math.round(limit * frac);              // linear pace
  const variance = spent - expectedToDate;                      // > 0 means spending ahead of pace
  const projected = frac > 0 ? Math.round(spent / frac) : spent;
  const fired = new Set(budget.firedBp || []);
  const alerts = (budget.alertsBp || [5000, 8000, 10000])
    .filter((t) => usedBp >= t && !fired.has(t))
    .map((t) => ({ kind: "threshold", bp: t }));
  // Pace alert: past 25 % of the period and heading over 110 % of the limit. Fires once per period.
  if (frac >= 0.25 && projected > limit * 1.1 && !fired.has(-1) && usedBp < 10000) alerts.push({ kind: "pace", bp: -1, projected });
  return { limit, spent, remaining: limit - spent, usedBp, expectedToDate, variance, projected, alerts };
}

// ---------- budget months and rollups ----------

// The budget month a date belongs to. With monthStartDay = 25 (payday), 2026-11-24 is in "2026-10"
// and 2026-11-25 is in "2026-11". Day 29-31 starts are clamped to the month's last day.
export function budgetMonth(date, startDay = 1) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) throw new PfmError("bad_date", String(date));
  let y = +m[1], mo = +m[2];
  const d = +m[3], last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > last) throw new PfmError("bad_date", String(date));
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31) throw new PfmError("bad_start_day");
  if (d < Math.min(startDay, last)) { mo -= 1; if (mo === 0) { mo = 12; y -= 1; } }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

// What one ledger row adds to its month's rollup: a list of [month, fieldPath, delta].
// Rows that are deleted, suggested (not yet confirmed) or transfers add nothing. A foreign-currency row
// without a rate only counts as "ratePending". Editing a row applies rollupDiff(old, new).
const CAT_ID = /^[A-Za-z0-9_]{1,40}$/;
export function rollupContrib(tx) {
  if (!tx || tx.deleted || tx.status === "suggested" || tx.kind === "transfer") return [];
  if (!CAT_ID.test(tx.categoryId || "")) throw new PfmError("bad_category");
  const out = [[tx.month, "txCount", 1]];
  if (tx.baseAmount == null) { out.push([tx.month, "ratePending", 1]); return out; }
  const k = tx.kind === "income" ? "i" : "e", v = tx.baseAmount, dd = tx.date.slice(8, 10);
  out.push([tx.month, k === "i" ? "income" : "expense", v], [tx.month, `cat.${tx.categoryId}.${k}`, v],
    [tx.month, `cat.${tx.categoryId}.n`, 1], [tx.month, `day.d${dd}.${k}`, v]);
  return out;
}
// Net change between two versions of a row (either may be null), merged per month and field, zeros dropped.
export function rollupDiff(before, after) {
  const acc = new Map();
  for (const [sign, tx] of [[-1, before], [1, after]])
    for (const [m, f, v] of rollupContrib(tx)) { const k = m + "|" + f; acc.set(k, (acc.get(k) || 0) + sign * v); }
  const byMonth = {};
  for (const [k, v] of acc) { if (!v) continue; const [m, f] = k.split("|"); (byMonth[m] ||= []).push([f, v]); }
  return byMonth;
}

// ---------- budget periods ----------

// First day, last day and length of a budget month (for monthStartDay = 25: 2026-11 runs 2026-11-25 .. 2026-12-24).
const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-based
export function budgetPeriod(month, startDay = 1) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw new PfmError("bad_month", String(month));
  const [y, m] = month.split("-").map(Number);
  const s = new Date(Date.UTC(y, m - 1, Math.min(startDay, lastDay(y, m))));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const e = new Date(Date.UTC(ny, nm - 1, Math.min(startDay, lastDay(ny, nm))));   // exclusive
  return { start: ymd(s), end: ymd(new Date(e - 86400000)), days: Math.round((e - s) / 86400000) };
}
// Days of the period that have started by `today` (today counts), clamped to 0..days.
export function periodElapsed(period, today) {
  const n = Math.round((utc(today) - utc(period.start)) / 86400000) + 1;
  return Math.min(Math.max(n, 0), period.days);
}

// ---------- recurring entries ----------

// rule: { freq: "monthly", day: 1..31, interval?: 1..12 } | { freq: "weekly", weekday: 0..6 (Sun..Sat), interval?: 1..4 }
//     | { freq: "yearly", month: 1..12, day: 1..31 }.  A day past the month's end means the last day (31 -> 30 Apr, 28/29 Feb).
export function checkRule(r) {
  const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  if (!r || typeof r !== "object") throw new PfmError("bad_rule");
  const interval = r.interval ?? 1;
  if (r.freq === "monthly" && int(r.day, 1, 31) && int(interval, 1, 12)) return { freq: "monthly", day: r.day, interval };
  if (r.freq === "weekly" && int(r.weekday, 0, 6) && int(interval, 1, 4)) return { freq: "weekly", weekday: r.weekday, interval };
  if (r.freq === "yearly" && int(r.month, 1, 12) && int(r.day, 1, 31)) return { freq: "yearly", month: r.month, day: r.day, interval: 1 };
  throw new PfmError("bad_rule");
}
const onDay = (y, m, d) => ymd(new Date(Date.UTC(y, m - 1, Math.min(d, lastDay(y, m)))));
// The first occurrence on or after `date`.
export function firstOccurrence(rule, date) {
  const r = checkRule(rule), t = utc(date), y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
  if (r.freq === "weekly") return ymd(new Date(+t + ((r.weekday - t.getUTCDay() + 7) % 7) * 86400000));
  if (r.freq === "monthly") { const c = onDay(y, m, r.day); return c >= date ? c : onDay(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, r.day); }
  const c = onDay(y, r.month, r.day); return c >= date ? c : onDay(y + 1, r.month, r.day);
}
// The occurrence after `date`, where `date` is itself an occurrence.
export function nextOccurrence(rule, date) {
  const r = checkRule(rule), t = utc(date), y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
  if (r.freq === "weekly") return ymd(new Date(+t + 7 * r.interval * 86400000));
  if (r.freq === "monthly") { const k = m - 1 + r.interval; return onDay(y + Math.floor(k / 12), (k % 12) + 1, r.day); }
  return onDay(y + 1, r.month, r.day);
}
// Occurrences due by `today`, oldest first, at most `max` (a long-paused rule catches up gradually).
export function dueOccurrences(rule, nextDate, today, endDate = null, max = 12) {
  const out = []; let d = nextDate;
  while (d <= today && (!endDate || d <= endDate) && out.length < max) { out.push(d); d = nextOccurrence(rule, d); }
  return { dates: out, next: d, ended: !!endDate && d > endDate };
}

// ---------- auto-categorisation rules ----------

// Matching ignores case, Arabic diacritics and tatweel, and the usual spelling variants (أ/إ/آ → ا, ى → ي, ة → ه).
export function normText(s) {
  return String(s || "").toLowerCase().normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627").replace(/\u0649/g, "\u064A").replace(/\u0629/g, "\u0647")
    .replace(/\s+/g, " ").trim();
}
// rules: [{ id, contains, categoryId, kind? }] in priority order. Longest match wins, so "uber eats" beats "uber".
export function matchCategoryRule(rules, { kind, counterparty, note }) {
  const hay = normText((counterparty || "") + " | " + (note || ""));
  let best = null;
  for (const r of rules || []) {
    const n = normText(r.contains);
    if (!n || (r.kind && kind && r.kind !== kind) || !hay.includes(n)) continue;
    if (!best || n.length > best.n.length) best = { n, categoryId: r.categoryId, id: r.id };
  }
  return best ? { categoryId: best.categoryId, ruleId: best.id } : null;
}

// Default categories. Names in Arabic and English; ids stable so rules and budgets can refer to them.
export const DEFAULT_CATEGORIES = [
  ["c_salary", "income", "Salary", "راتب", "briefcase", "#0f766e"], ["c_freelance", "income", "Freelance", "عمل حرّ", "laptop", "#0e7490"],
  ["c_invoices", "income", "Invoices", "فواتير", "receipt", "#15803d"], ["c_gifts_in", "income", "Gifts received", "هدايا مستلمة", "gift", "#65a30d"],
  ["c_other_in", "income", "Other income", "دخل آخر", "plus", "#4d7c0f"],
  ["c_food", "expense", "Food & groceries", "طعام ومشتريات", "cart", "#c2410c"], ["c_rent", "expense", "Rent & housing", "سكن وإيجار", "home", "#b91c1c"],
  ["c_utilities", "expense", "Utilities", "خدمات ومرافق", "bolt", "#a16207"], ["c_transport", "expense", "Transport", "مواصلات", "car", "#7c3aed"],
  ["c_telecom", "expense", "Phone & internet", "اتصالات وإنترنت", "phone", "#2563eb"], ["c_health", "expense", "Health", "صحّة", "heart", "#db2777"],
  ["c_education", "expense", "Education", "تعليم", "book", "#4f46e5"], ["c_family", "expense", "Family", "عائلة", "users", "#9333ea"],
  ["c_maintenance", "expense", "Maintenance", "صيانة", "wrench", "#57534e"], ["c_fees", "expense", "Fees", "رسوم", "percent", "#64748b"],
  ["c_other_out", "expense", "Other expenses", "مصروفات أخرى", "dots", "#475569"],
].map(([id, kind, name, nameAr, icon, color], order) => ({ id, kind, name, nameAr, icon, color, order, system: true, archived: false }));

// ---------- ledger analytics ----------

/**
 * txs: [{ kind: "income"|"expense"|"transfer", amount (always > 0), currency, baseAmount?, categoryId, refundOf? }]
 * Totals are in the user's base currency: each row's baseAmount (converted when the row was written,
 * at the rate stored on the row). byCurrency also gives the original amounts per currency.
 * Transfers between the user's own accounts are not income or spending.
 * A refund is an "income" row with refundOf set. It reduces the original category's spending.
 */
export function summarize(txs, { base } = {}) {
  let income = 0, expense = 0, ratePending = 0;
  const cats = new Map(), curs = new Map();
  for (const t of txs) {
    if (t.kind === "transfer" || t.deleted) continue;
    // A foreign-currency row saved without a rate ("rate pending") has no baseAmount. It is counted in
    // byCurrency but left out of base totals; summing it as if it were base currency would be wrong.
    const foreign = base && t.currency && t.currency !== base;
    if (foreign && t.baseAmount == null) { ratePending++; bump(curs, t.currency, t.kind === "income" && !t.refundOf ? "income" : "expense", (t.refundOf ? -1 : 1) * t.amount); continue; }
    const v = t.baseAmount ?? t.amount;
    if (t.currency) {
      const k = t.kind === "income" && !t.refundOf ? "income" : "expense", sign = t.refundOf ? -1 : 1;
      bump(curs, t.currency, k, sign * t.amount);
    }
    if (t.kind === "income" && t.refundOf) { expense -= v; bump(cats, t.categoryId, "expense", -v); continue; }
    if (t.kind === "income") { income += v; bump(cats, t.categoryId, "income", v); }
    else if (t.kind === "expense") { expense += v; bump(cats, t.categoryId, "expense", v); }
  }
  const net = income - expense;
  return {
    income, expense, net,
    savingsRateBp: income > 0 ? Number(divRound(big(net) * BP, big(income))) : null,
    byCategory: [...cats.entries()].map(([categoryId, v]) => ({
      categoryId, ...v, shareBp: expense > 0 && v.expense > 0 ? Number(divRound(big(v.expense) * BP, big(expense))) : 0,
    })).sort((a, b) => b.expense - a.expense || b.income - a.income),
    byCurrency: [...curs.entries()].map(([currency, v]) => ({ currency, ...v })),
    ratePending,                                   // rows waiting for the user to add a rate
  };
}
function bump(m, id, k, v) { const e = m.get(id) || { income: 0, expense: 0 }; e[k] += v; m.set(id, e); }

// ---------- wallet auto-sync ----------

// Turns a wallet ledger event into a ledger row. The id is derived from the wallet tx,
// so the same event delivered twice writes the same document and cannot double-count.
export function walletEventToTx(evt, rules = []) {
  const map = {
    "transfer.in": "income", "invoice.received": "income", "refund": "income",
    "transfer.out": "expense", "purchase": "expense", "bill": "expense", "invoice.paid": "expense", "fee": "expense",
    "topup": "transfer", "withdraw": "transfer",
  };
  const kind = map[evt.type];
  if (!kind) return null;
  const rule = rules.find((r) => matchRule(r, evt));
  const fallback = { "transfer.in": "c_transfers_in", "invoice.received": "c_invoices", refund: "c_refunds", fee: "c_fees", bill: "c_utilities", topup: "c_internal", withdraw: "c_internal" };
  return {
    id: "w_" + evt.walletTxId,
    kind, amount: Math.abs(evt.amount), currency: evt.currency,
    occurredAt: evt.at, source: "wallet", walletTxId: evt.walletTxId,
    counterparty: evt.counterpartyName || null,
    categoryId: rule ? rule.categoryId : fallback[evt.type] || "c_uncategorized",
    autoCategorized: !!rule, refundOf: evt.type === "refund" && evt.refundOf ? "w_" + evt.refundOf : null,
    invoiceId: evt.invoiceId || null,
  };
}
function matchRule(r, evt) {
  if (r.type && r.type !== evt.type) return false;
  if (r.counterpartyUid && r.counterpartyUid !== evt.counterpartyUid) return false;
  if (r.mcc && r.mcc !== evt.mcc) return false;
  if (r.contains && !(evt.counterpartyName || "").toLowerCase().includes(r.contains.toLowerCase())) return false;
  return true;
}

// ---------- audit hash chain ----------

// Stable JSON: object keys sorted, so the same entry always hashes the same.
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const GENESIS = "0".repeat(64);

// Each entry commits to the previous hash. Editing or removing any past entry breaks every later hash.
export async function auditEntry(prev, body) {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : GENESIS;
  const entry = { seq, prevHash, ...body };
  return { ...entry, hash: await sha256hex(prevHash + "|" + canonical(entry)) };
}
export async function verifyChain(entries) {
  let prev = null;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (rest.seq !== (prev ? prev.seq + 1 : 1) || rest.prevHash !== (prev ? prev.hash : GENESIS)) return { ok: false, at: e.seq, why: "link" };
    if (hash !== await sha256hex(rest.prevHash + "|" + canonical(rest))) return { ok: false, at: e.seq, why: "hash" };
    prev = e;
  }
  return { ok: true, head: prev ? prev.hash : GENESIS, count: entries.length };
}

// ---------- field encryption (AES-256-GCM, a key per user) ----------

// Each user's key comes from a master secret (Worker secret PFM_KEK_v{n}) by HKDF over the uid.
// Ciphertext format: "v1:<keyVersion>:<b64 iv>:<b64 ct>". The uid is bound in as AAD,
// so a ciphertext copied into another user's document fails to decrypt.
// In chunks: spreading a large array into fromCharCode overflows the call stack (a 400 KB receipt photo did).
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function userKey(masterB64, uid) {
  const ikm = await crypto.subtle.importKey("raw", unb64(masterB64), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("sawa-pfm"), info: new TextEncoder().encode("uid:" + uid) },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/**
 * Stable, private id for an imported bank transaction (IMPORT-DESIGN.md §4.5): "m_" + 32 chars of
 * HMAC-SHA256(key derived from the v1 master secret and the uid, "<issuer>:<reference>").
 * Always the v1 secret, so a key rotation does not change ids (and duplicates stay caught). Without the key,
 * the id reveals nothing about the reference.
 */
export async function importRefId(issuer, ref, uid, masterB64v1) {
  if (!/^[a-z0-9-]{2,20}$/.test(String(issuer || ""))) throw new PfmError("bad_ref");
  const r = String(ref || "").trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(r)) throw new PfmError("bad_ref");
  const ikm = await crypto.subtle.importKey("raw", unb64(masterB64v1), "HKDF", false, ["deriveKey"]);
  const k = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("sawa-pfm"), info: new TextEncoder().encode("ref:" + uid) },
    ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(issuer + ":" + r)));
  return "m_" + b64(mac).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

export async function sealField(plain, uid, masterB64, keyVersion = 1) {
  if (plain == null || plain === "") return plain ?? null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(uid) },
    await userKey(masterB64, uid), new TextEncoder().encode(String(plain)));
  return `v1:${keyVersion}:${b64(iv)}:${b64(new Uint8Array(ct))}`;
}
export async function openField(sealed, uid, keys /* {1: masterB64, 2: ...} */) {
  if (sealed == null || sealed === "") return sealed ?? null;
  const [v, kv, iv, ct] = sealed.split(":");
  if (v !== "v1" || !keys[kv]) throw new PfmError("bad_cipher");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(uid) },
    await userKey(keys[kv], uid), unb64(ct));
  return new TextDecoder().decode(pt);
}
