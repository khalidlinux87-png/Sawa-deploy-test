// Sawa Personal Accountant: pure logic (no I/O). Runs in the Worker and in Node tests.
// Every amount is an integer in the currency's minor unit (SDG 1.00 = 100).
// Floats never touch money. Products of quantity and price use BigInt.

export const CURRENCY_EXP = { SDG: 2, USD: 2, EUR: 2, SAR: 2, AED: 2, EGP: 2, QAR: 2, KWD: 3, BHD: 3, OMR: 3 };
const BP = 10000n;            // basis points: 1500 = 15.00 %
const QTY_SCALE = 1000n;      // quantities carry 3 decimals: "2.5" -> 2500

export class PfmError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

// ---------- parsing and formatting ----------

// Parses "1,234.5" to a minor-unit integer without floats. Rejects excess precision.
export function toMinor(input, currency) {
  const exp = CURRENCY_EXP[currency];
  if (exp == null) throw new PfmError("bad_currency", currency);
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

export function fromMinor(minor, currency) {
  const exp = CURRENCY_EXP[currency];
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
 * items: [{ description, qty: "2.5", unitPrice: minor, discount?: {type:"pct",bp}|{type:"amt",minor}, taxBp?: 1500 }]
 * opts:  { currency, invoiceDiscount?: {type,bp|minor}, taxInclusive?: false, amountPaid?: 0 }
 * Discounts apply before tax. Tax is computed per line, then summed per rate.
 */
export function computeInvoice(items, opts) {
  const { currency, invoiceDiscount = null, taxInclusive = false, amountPaid = 0 } = opts;
  if (CURRENCY_EXP[currency] == null) throw new PfmError("bad_currency", currency);
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) throw new PfmError("bad_items");

  const lines = items.map((it, i) => {
    if (!Number.isSafeInteger(it.unitPrice) || it.unitPrice < 0) throw new PfmError("bad_price", "line " + (i + 1));
    const taxBp = it.taxBp ?? 0;
    if (!Number.isInteger(taxBp) || taxBp < 0 || taxBp > 10000) throw new PfmError("bad_tax", "line " + (i + 1));
    const qty = toQty(it.qty);
    const gross = divRound(big(it.unitPrice) * qty, QTY_SCALE);
    const lineDisc = discountOf(gross, it.discount);
    return { i, qty, taxBp, gross, lineDisc };
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
      net = divRound(afterDisc * BP, BP + big(l.taxBp));
      tax = afterDisc - net;
    } else {
      net = afterDisc;
      tax = divRound(net * big(l.taxBp), BP);
    }
    grossTotal += l.gross; lineDiscountTotal += l.lineDisc; netTotal += net; taxTotal += tax;
    const r = byRate.get(l.taxBp) || { taxBp: l.taxBp, taxable: 0n, tax: 0n };
    r.taxable += net; r.tax += tax; byRate.set(l.taxBp, r);
    // amount: what the row shows (after its own discount, before tax and the invoice-wide discount).
    // invoiceDiscountShare, net and tax: the basis that the tax is computed on.
    return { index: l.i, qtyMilli: num(l.qty), gross: num(l.gross), lineDiscount: num(l.lineDisc), amount: num(l.gross - l.lineDisc),
      invoiceDiscountShare: num(shares[k]), net: num(net), taxBp: l.taxBp, tax: num(tax), total: num(net + tax) };
  });

  const total = netTotal + taxTotal;
  const paid = big(amountPaid);
  return {
    currency, lines: outLines,
    grossTotal: num(grossTotal), lineDiscountTotal: num(lineDiscountTotal),
    subtotal: num(grossTotal - lineDiscountTotal),      // sum of row amounts
    invoiceDiscount: num(invDisc), netTotal: num(netTotal),
    taxTotal: num(taxTotal), total: num(total),
    taxBreakdown: [...byRate.values()].filter((r) => r.taxBp > 0)
      .sort((a, b) => a.taxBp - b.taxBp).map((r) => ({ taxBp: r.taxBp, taxable: num(r.taxable), tax: num(r.tax) })),
    amountPaid: num(paid), amountDue: num(total - paid > 0n ? total - paid : 0n),
  };
}

function discountOf(base, d) {
  if (!d) return 0n;
  let v;
  if (d.type === "pct") {
    if (!Number.isInteger(d.bp) || d.bp < 0 || d.bp > 10000) throw new PfmError("bad_discount");
    v = divRound(base * big(d.bp), BP);
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
export function applyPayment(inv, amount) {
  if (!["sent", "overdue"].includes(inv.status)) throw new PfmError("not_payable", inv.status);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PfmError("bad_amount");
  const due = inv.total - inv.amountPaid;
  if (amount > due) throw new PfmError("overpay", "due " + due);
  const amountPaid = inv.amountPaid + amount;
  return { amountPaid, amountDue: inv.total - amountPaid, status: amountPaid === inv.total ? "paid" : inv.status };
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

// ---------- ledger analytics ----------

/**
 * txs: [{ kind: "income"|"expense"|"transfer", amount (always > 0), categoryId, refundOf? }]
 * Transfers between the user's own accounts are not income or spending.
 * A refund is an "income" row with refundOf set. It reduces the original category's spending.
 */
export function summarize(txs) {
  let income = 0, expense = 0;
  const cats = new Map();
  for (const t of txs) {
    if (t.kind === "transfer" || t.deleted) continue;
    if (t.kind === "income" && t.refundOf) { expense -= t.amount; bump(cats, t.categoryId, "expense", -t.amount); continue; }
    if (t.kind === "income") { income += t.amount; bump(cats, t.categoryId, "income", t.amount); }
    else if (t.kind === "expense") { expense += t.amount; bump(cats, t.categoryId, "expense", t.amount); }
  }
  const net = income - expense;
  return {
    income, expense, net,
    savingsRateBp: income > 0 ? Number(divRound(big(net) * BP, big(income))) : null,
    byCategory: [...cats.entries()].map(([categoryId, v]) => ({
      categoryId, ...v, shareBp: expense > 0 && v.expense > 0 ? Number(divRound(big(v.expense) * BP, big(expense))) : 0,
    })).sort((a, b) => b.expense - a.expense || b.income - a.income),
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
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function userKey(masterB64, uid) {
  const ikm = await crypto.subtle.importKey("raw", unb64(masterB64), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("sawa-pfm"), info: new TextEncoder().encode("uid:" + uid) },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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
