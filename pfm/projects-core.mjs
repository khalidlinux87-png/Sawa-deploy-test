// Sawa Personal Accountant: Projects (pure logic, no I/O). Runs in the Worker and in Node tests.
// Spec: pfm/PROJECTS.md. Same rules as pfm-core.mjs:
//   - money is an integer in the project's currency's minor unit (SDG 1.00 = 100); floats never touch money;
//   - quantities are BigInt scaled by 1000 (3 decimals, as toQty() returns); stored as decimal text ("2.5");
//   - a user-typed FX rate converts an entry into the project currency (decision 8 and 11 of DESIGN.md).
// Nothing here reads or writes Firestore. The Worker loads rows, calls these functions, then commits.

import { currencyExp, toMinor, toQty, convert, PfmError } from "./pfm-core.mjs";

export { PfmError };

export const PROJECT_TEMPLATES = Object.freeze(["house_construction", "event", "small_business", "agri_season", "custom"]);
export const PROJECT_STATUSES = Object.freeze(["planning", "active", "on_hold", "completed", "archived"]);
export const ESTIMATE_STATUSES = Object.freeze(["draft", "baseline", "superseded"]);
export const BOQ_CATEGORIES = Object.freeze(["raw_materials", "labor", "equipment_rental", "permits", "other"]);

// Every project ledger kind and the direction it moves money.
// Only `expense` is project cost. `loan_repayment` is cash out but not cost (principal), so it is left out of spend.
export const TX_KINDS = Object.freeze({
  capital_injection: "inflow",
  loan_draw: "inflow",
  partner_contribution: "inflow",
  grant: "inflow",
  revenue: "inflow",
  expense: "outflow",
  loan_repayment: "outflow",
});
export const FUNDING_KINDS = Object.freeze(["capital_injection", "loan_draw", "partner_contribution", "grant"]);

export const DEFAULT_THRESHOLDS_PCT = Object.freeze([80, 100]);
export const DEFAULT_LINE_TOLERANCE_PCT = 5;

const QTY_SCALE = 1000n;
const BP = 10000n;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_STATUS_TRANSITIONS = Object.freeze({
  planning: ["active", "archived"],
  active: ["on_hold", "completed", "archived"],
  on_hold: ["active", "archived"],
  completed: ["active", "archived"],
  archived: [],
});

// ---------- small helpers ----------

const big = (x) => BigInt(x);
const toNum = (x) => {
  const v = Number(x);
  if (!Number.isSafeInteger(v)) throw new PfmError("too_large");
  return v;
};
// Rounds num/den half away from zero. BigInt in, BigInt out.
function divRound(num, den) {
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num, d = den < 0n ? -den : den;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

// Canonical text of a scaled quantity: 2500n -> "2.5", 10000n -> "10", -500n -> "-0.5"
export function qtyText(q) {
  const v = big(q), neg = v < 0n, a = neg ? -v : v;
  const w = a / QTY_SCALE, f = a % QTY_SCALE;
  const body = f ? `${w}.${String(f).padStart(3, "0").replace(/0+$/, "")}` : `${w}`;
  return (neg ? "-" : "") + body;
}
// Accepts a scaled BigInt or the stored text form.
const qOf = (v) => (typeof v === "string" ? toQty(v) : big(v ?? 0));

function assertDate(s, code = "bad_date") {
  if (typeof s !== "string" || !DATE_RE.test(s)) throw new PfmError(code, String(s));
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new PfmError(code, s);
  return s;
}
function text(v, max, code, required) {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new PfmError(code, "required");
  if (s.length > max) throw new PfmError(code, `longer than ${max}`);
  return s;
}

// ---------- validation (user input → clean values) ----------

export function validateProjectInput(input = {}) {
  const currency = input.currency;
  currencyExp(currency); // throws bad_currency for anything outside the twelve
  const template = input.template ?? "custom";
  if (!PROJECT_TEMPLATES.includes(template)) throw new PfmError("bad_template", String(template));
  const startDate = input.startDate ? assertDate(input.startDate) : null;
  const endDate = input.endDate ? assertDate(input.endDate) : null;
  if (startDate && endDate && endDate < startDate) throw new PfmError("bad_dates", "end before start");

  const targetBudget = toMinor(input.targetBudget ?? "", currency);
  if (targetBudget <= 0) throw new PfmError("bad_budget", "budget must be above zero");

  const thresholds = input.alertThresholdsPct ?? [...DEFAULT_THRESHOLDS_PCT];
  if (!Array.isArray(thresholds) || thresholds.length < 1 || thresholds.length > 5 ||
      thresholds.some((t, i) => !Number.isInteger(t) || t < 1 || t > 200 || (i > 0 && t <= thresholds[i - 1]))) {
    throw new PfmError("bad_thresholds", "ascending whole percentages, 1 to 200");
  }
  const tolerance = input.lineTolerancePct ?? DEFAULT_LINE_TOLERANCE_PCT;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 100) throw new PfmError("bad_tolerance", String(tolerance));

  return {
    name: text(input.name, 120, "bad_name", true),
    template,
    description: text(input.description, 500, "bad_description", false),
    currency,
    startDate,
    endDate,
    targetBudget,
    alertThresholdsPct: [...thresholds],
    lineTolerancePct: tolerance,
    status: "planning",
  };
}

// One BOQ line. estQty is text ("2.5") or BigInt; estUnitPrice is text or minor units.
// C284: every price carries the date it was quoted (priceDate, the date on the supplier's quote or the day it was
// checked) and optionally who quoted it. `today` (the user's local date) is the default and the upper bound.
export function validateBoqLine(input = {}, currency, today = null) {
  if (!ID_RE.test(input.lineKey ?? "")) throw new PfmError("bad_line_key", String(input.lineKey));
  if (!BOQ_CATEGORIES.includes(input.category)) throw new PfmError("bad_category", String(input.category));
  const estQty = qOf(input.estQty);
  if (estQty <= 0n) throw new PfmError("bad_qty", "quantity must be above zero");
  const estUnitPrice = toMinor(input.estUnitPrice ?? "0", currency);
  if (estUnitPrice < 0) throw new PfmError("bad_amount", "unit price cannot be negative");
  return {
    lineKey: input.lineKey,
    category: input.category,
    name: text(input.name, 160, "bad_name", true),
    unit: text(input.unit, 16, "bad_unit", true),
    estQty,
    estUnitPrice,
    estTotal: lineTotal(estQty, estUnitPrice),
    priceDate: priceDateOf(input.priceDate, today),
    supplier: text(input.supplier, 120, "bad_supplier", false),
  };
}

const MIN_DOC_DATE = "2000-01-01";
// A date on a document or a quote: a real date, not before 2000, not after today (when today is known).
function priceDateOf(v, today) {
  if (v == null || v === "") return today ? assertDate(today, "bad_price_date") : null;   // no date and no "today": callers that predate C284
  assertDate(v, "bad_price_date");
  if (v < MIN_DOC_DATE || (today && v > today)) throw new PfmError("bad_price_date", "out of range");
  return v;
}

// ---------- price history (C284) ----------
// Each BOQ line keeps a priceLog: one entry per price change, stamped by the server. The log is copied into the next
// revision with the line, so the history follows the lineKey across change orders. Approved revisions are read-only,
// so a past price can never be rewritten. Entries: { unitPrice, priceDate, pricedAt, by, revision, supplier? }.
export const PRICE_LOG_MAX = 60;

// The log after saving a line. `old` is the stored line of the same draft (or the copy from the baseline), or null.
// Returns { pricedAt, priceLog } — unchanged when the price, its date and its supplier are the same.
export function nextPriceLog(old, v, { at, by, revision }) {
  const prevLog = Array.isArray(old?.priceLog) ? old.priceLog : [];
  const same = old && old.estUnitPrice === v.estUnitPrice && (old.priceDate || null) === v.priceDate && (old.supplierPlain ?? old.supplier ?? "") === (v.supplier || "");
  if (same && old.pricedAt) return { pricedAt: old.pricedAt, priceLog: prevLog, changed: false };
  const entry = { unitPrice: v.estUnitPrice, priceDate: v.priceDate, pricedAt: at, by, revision, supplier: v.supplier || null };
  let log = [...prevLog, entry];
  if (log.length > PRICE_LOG_MAX) log = [log[0], ...log.slice(log.length - PRICE_LOG_MAX + 1)];   // keep the first price and the latest
  return { pricedAt: at, priceLog: log, changed: true };
}

// Unit price actually paid on an expense with a quantity: amount ÷ quantity, in minor units (rounded).
export function actualUnitPrice(amount, quantity) {
  const q = qOf(quantity);
  if (q <= 0n) return null;
  return toNum(divRound(big(amount) * QTY_SCALE, q));
}

// Price history for one line: estimate prices over time (from the priceLog of every revision, de-duplicated),
// quotes attached as files, and the prices actually paid (posted expenses on the line with a quantity).
// changeBp: latest estimate vs the first one. actualVsEstimateBp: weighted average paid vs the price in force
// on the day of each purchase (the latest estimate priced on or before that day; else the first estimate).
export function priceHistory(lineKey, logs, quotes, txs) {
  const seen = new Set(), est = [];
  for (const e of logs.flat()) {
    if (!e || typeof e.unitPrice !== "number") continue;
    const k = e.pricedAt + "|" + e.unitPrice + "|" + e.priceDate;
    if (seen.has(k)) continue;
    seen.add(k); est.push(e);
  }
  est.sort((a, b) => (a.pricedAt < b.pricedAt ? -1 : a.pricedAt > b.pricedAt ? 1 : 0));
  // lines saved before C284 have no log; each revision then yields one stand-in entry. Keep it only when the price moved.
  for (let i = est.length - 1; i > 0; i--) if (est[i].by == null && est[i].unitPrice === est[i - 1].unitPrice && est[i].priceDate === est[i - 1].priceDate) est.splice(i, 1);
  const actual = txs.filter((t) => t.status !== "voided" && t.kind === "expense" && t.lineKey === lineKey && t.quantity)
    .map((t) => ({ txId: t.id, occurredOn: t.occurredOn, quantity: t.quantity, amount: t.amount, unitPrice: actualUnitPrice(t.amount, t.quantity), createdAt: t.createdAt }))
    .filter((a) => a.unitPrice != null)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  const q = quotes.filter((f) => f.quotedUnitPrice != null).map((f) => ({ fileId: f.id, docDate: f.docDate, unitPrice: f.quotedUnitPrice, uploadedAt: f.uploadedAt }))
    .sort((a, b) => (a.docDate < b.docDate ? -1 : 1));
  const first = est[0] || null, latest = est[est.length - 1] || null;
  const inForce = (day) => { let r = null; for (const e of est) if (e.priceDate <= day) r = !r || e.priceDate >= r.priceDate ? e : r; return r || first; };
  let paid = 0n, expected = 0n;
  for (const a of actual) { const e = inForce(a.occurredOn); if (!e) continue; paid += big(a.amount); expected += divRound(big(e.unitPrice) * qOf(a.quantity), QTY_SCALE); }
  const bp = (now, was) => (was > 0n ? toNum(divRound((now - was) * 10000n, was)) : null);
  return {
    lineKey, estimates: est, quotes: q, actual,
    firstEstimate: first, latestEstimate: latest, latestActual: actual[actual.length - 1] || null,
    changeBp: first && latest ? bp(big(latest.unitPrice), big(first.unitPrice)) : null,
    actualVsEstimateBp: actual.length && expected > 0n ? bp(paid, expected) : null,
  };
}

// ---------- attachments (C284) ----------
// Photos, quotes, supplier invoices and receipts on a project, an estimate revision, a BOQ line or a ledger entry.
// The bytes are sealed and split into parts (Firestore documents hold ≤ 1 MiB). Attachments are never edited:
// the document date and the upload time are fixed when added. Removing keeps the record (who, when, why) and drops the bytes.
export const FILE_KINDS = Object.freeze(["photo", "quote", "supplier_invoice", "receipt", "other"]);
export const FILE_TARGETS = Object.freeze(["project", "estimate", "line", "tx"]);
export const FILE_MAX = 4 * 1024 * 1024;
export const FILE_PART = 384 * 1024;           // raw bytes per part; sealed base64 ≈ 690 KB
export const FILES_PER_TARGET = 20;
export const FILES_PER_PROJECT = 300;
const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateAttachment(input = {}, today, currency) {
  if (!FILE_KINDS.includes(input.kind)) throw new PfmError("bad_file_kind", String(input.kind));
  const t = input.target || {};
  if (!FILE_TARGETS.includes(t.type)) throw new PfmError("bad_target", String(t.type));
  const target = { type: t.type };
  if (t.type === "estimate" || t.type === "line") {
    if (!TARGET_ID_RE.test(t.estimateId || "")) throw new PfmError("bad_target", "estimateId");
    target.estimateId = t.estimateId;
  }
  if (t.type === "line") {
    if (!ID_RE.test(t.lineKey || "")) throw new PfmError("bad_line_key", String(t.lineKey));
    target.lineKey = t.lineKey;
  }
  if (t.type === "tx") {
    if (!TARGET_ID_RE.test(t.txId || "")) throw new PfmError("bad_target", "txId");
    target.txId = t.txId;
  }
  if (!today) throw new PfmError("bad_date", "today required");
  const docDate = priceDateOf(input.docDate, today);
  let quotedUnitPrice = null;
  if (input.quotedUnitPrice != null && input.quotedUnitPrice !== "") {
    if (input.kind !== "quote" || t.type !== "line") throw new PfmError("bad_quote", "a quoted price belongs to a quote on a line");
    quotedUnitPrice = toMinor(input.quotedUnitPrice, currency);
    if (quotedUnitPrice < 0) throw new PfmError("bad_amount", "price cannot be negative");
  }
  return { kind: input.kind, target, name: text(input.name, 120, "bad_file_name", false) || null, note: text(input.note, 300, "bad_note", false) || null, docDate, quotedUnitPrice };
}
// The key that groups files by what they are attached to.
export const targetKey = (t) => (t.type === "project" ? "project" : t.type === "estimate" ? `e:${t.estimateId}` : t.type === "line" ? `l:${t.estimateId}:${t.lineKey}` : `t:${t.txId}`);

// A ledger entry. Returns values ready to store (amount in the project currency).
export function validateProjectTx(input = {}, project) {
  const kind = input.kind;
  if (!Object.hasOwn(TX_KINDS, kind)) throw new PfmError("bad_kind", String(kind));
  const currency = input.currency ?? project.currency;
  currencyExp(currency);

  let amount = toMinor(input.amount ?? "", currency);
  if (amount <= 0) throw new PfmError("bad_amount", "amount must be above zero");
  let fxRate = null;
  if (currency !== project.currency) {
    if (!input.fxRate) throw new PfmError("fx_rate_required", `${currency} needs a rate to ${project.currency}`);
    fxRate = String(input.fxRate);
    amount = convert(amount, currency, project.currency, fxRate); // throws bad_fx_rate
    if (amount <= 0) throw new PfmError("bad_amount", "too small after conversion");
  }

  const tx = {
    kind,
    direction: TX_KINDS[kind],
    description: text(input.description, 200, "bad_description", true),
    counterparty: text(input.counterparty, 120, "bad_counterparty", false),
    occurredOn: assertDate(input.occurredOn),
    amount,
    originalAmount: toMinor(input.amount, currency),
    originalCurrency: currency,
    fxRate,
    lineKey: null,
    category: null,
    quantity: null,
    unit: null,
  };

  if (kind === "expense") {
    if (input.lineKey) {
      if (!ID_RE.test(input.lineKey)) throw new PfmError("bad_line_key", String(input.lineKey));
      tx.lineKey = input.lineKey;
    } else {
      if (!BOQ_CATEGORIES.includes(input.category)) throw new PfmError("bad_category", "an unbudgeted expense needs a category");
      tx.category = input.category;
    }
    if (input.quantity != null && input.quantity !== "") {
      tx.quantity = qOf(input.quantity);
      if (tx.quantity <= 0n) throw new PfmError("bad_qty", "quantity must be above zero");
      tx.unit = text(input.unit, 16, "bad_unit", true);
    }
  } else if (input.lineKey) {
    throw new PfmError("line_on_non_expense", kind);
  }
  return tx;
}

// ---------- estimate arithmetic ----------

// Line total = round(quantity × unit price). quantity is scaled by 1000, so divide by it once.
export function lineTotal(estQty, unitPriceMinor) {
  return toNum(divRound(qOf(estQty) * big(unitPriceMinor), QTY_SCALE));
}

export function estimateTotals(lines) {
  let total = 0n;
  const byCategory = {};
  for (const l of lines) {
    const t = big(l.estTotal);
    total += t;
    byCategory[l.category] = toNum(big(byCategory[l.category] ?? 0) + t);
  }
  return { total: toNum(total), byCategory };
}

export function assertUniqueLineKeys(lines) {
  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.lineKey)) throw new PfmError("dup_line_key", l.lineKey);
    seen.add(l.lineKey);
  }
}

// ---------- ledger aggregation (posted entries only) ----------

// Totals over a project's ledger. Voided entries are ignored.
export function ledgerTotals(txs) {
  const t = {
    funding: 0n, revenue: 0n, inflows: 0n, outflows: 0n,
    spend: 0n,            // all project cost: expenses on lines plus unbudgeted expenses
    unbudgetedSpend: 0n,
    byLine: new Map(),    // lineKey -> { qty, cost }
  };
  for (const x of txs) {
    if (x.status === "voided") continue;
    const amt = big(x.amount);
    if (x.direction === "inflow") {
      t.inflows += amt;
      if (FUNDING_KINDS.includes(x.kind)) t.funding += amt;
      if (x.kind === "revenue") t.revenue += amt;
    } else {
      t.outflows += amt;
      if (x.kind === "expense") {
        t.spend += amt;
        if (x.lineKey) {
          const a = t.byLine.get(x.lineKey) ?? { qty: 0n, cost: 0n };
          a.cost += amt;
          if (x.quantity != null) a.qty += qOf(x.quantity);
          t.byLine.set(x.lineKey, a);
        } else {
          t.unbudgetedSpend += amt;
        }
      }
    }
  }
  return t;
}

// ---------- variance ----------

/**
 * Variance for one BOQ line.
 *   line: { lineKey, estQty, estUnitPrice (minor), estTotal (minor) }
 *   act:  { qty, cost }  from ledgerTotals().byLine (qty may be 0 when expenses carry no quantity)
 *
 * Decomposition (exact, in minor units):
 *   totalVariance  = actualCost − estTotal
 *   quantityEffect = (actualQty − estQty) × estUnitPrice      "we used more or less than planned"
 *   priceEffect    = totalVariance − quantityEffect           "we paid more or less per unit"
 * Algebraically this equals (actualUnitPrice − estUnitPrice) × actualQty. Taking it as the remainder
 * keeps the two effects summing exactly to the total despite rounding.
 *
 * Status: not_started (no cost) · on_budget (cost ≤ estimate) · warning (above estimate, within tolerance)
 *         · over_budget (above estimate by more than tolerancePct).
 */
export function lineVariance(line, act = { qty: 0n, cost: 0n }, tolerancePct = DEFAULT_LINE_TOLERANCE_PCT) {
  const EQ = qOf(line.estQty), EP = big(line.estUnitPrice), ET = big(line.estTotal);
  const AQ = qOf(act.qty), AC = big(act.cost);
  const AP = AQ > 0n ? divRound(AC * QTY_SCALE, AQ) : null;   // actual unit price, minor units

  const totalVariance = AC - ET;
  const quantityEffect = divRound((AQ - EQ) * EP, QTY_SCALE);
  const priceEffect = totalVariance - quantityEffect;

  let status;
  if (AC === 0n) status = "not_started";
  else if (AC * 100n > ET * BigInt(100 + tolerancePct)) status = "over_budget";
  else if (AC > ET) status = "warning";
  else status = "on_budget";

  return {
    lineKey: line.lineKey,
    estQty: qtyText(EQ),
    actualQty: qtyText(AQ),
    qtyVariance: qtyText(AQ - EQ),
    qtyVariancePct: EQ > 0n ? toNum(divRound((AQ - EQ) * 10000n, EQ)) / 100 : null,
    estUnitPrice: toNum(EP),
    actualUnitPrice: AP === null ? null : toNum(AP),
    estTotal: toNum(ET),
    actualCost: toNum(AC),
    quantityEffect: toNum(quantityEffect),
    priceEffect: toNum(priceEffect),
    totalVariance: toNum(totalVariance),
    status,
  };
}

// ---------- project health ----------

/**
 * Health of one project against its approved estimate.
 *   project: { targetBudget, alertThresholdsPct, lineTolerancePct, currency }
 *   lines:   validated BOQ lines of the baseline (or of the current revision)
 *   txs:     ledger rows (stored or validated form)
 *
 * Definitions:
 *   utilization   = actualSpend ÷ targetBudget
 *   EAC           = Σ max(actual line cost, line estimate) + unbudgeted spend + spend on lines no longer in the estimate
 *   margin        = (revenue − actualSpend) ÷ revenue          (null without revenue)
 *   cashPosition  = all inflows − all outflows (loan repayments included)
 *   status        = red if utilization ≥ 100 % or EAC > budget · amber if utilization ≥ the first threshold · else green
 * Basis points (1 bp = 0.01 %) keep percentages exact.
 */
export function projectHealth(project, lines, txs) {
  const L = ledgerTotals(txs);
  const target = big(project.targetBudget);
  const tol = project.lineTolerancePct ?? DEFAULT_LINE_TOLERANCE_PCT;
  const thresholds = project.alertThresholdsPct ?? DEFAULT_THRESHOLDS_PCT;

  const known = new Set(lines.map((l) => l.lineKey));
  const variances = lines.map((l) => lineVariance(l, L.byLine.get(l.lineKey), tol));

  let eac = 0n, estimatedTotal = 0n;
  for (const l of lines) {
    const e = big(l.estTotal), a = L.byLine.get(l.lineKey)?.cost ?? 0n;
    estimatedTotal += e;
    eac += a > e ? a : e;
  }
  let orphanSpend = 0n;
  for (const [k, v] of L.byLine) if (!known.has(k)) orphanSpend += v.cost;
  eac += orphanSpend + L.unbudgetedSpend;

  const utilBp = target > 0n ? divRound(L.spend * BP, target) : 0n;
  const net = L.revenue - L.spend;
  const crossed = thresholds.filter((p) => utilBp >= BigInt(p) * 100n);
  const status = utilBp >= BP || eac > target ? "red"
    : utilBp >= BigInt(thresholds[0]) * 100n ? "amber" : "green";

  return {
    currency: project.currency,
    targetBudget: toNum(target),
    estimatedTotal: toNum(estimatedTotal),
    budgetGap: toNum(target - estimatedTotal),       // > 0: the estimate fits inside the budget
    actualSpend: toNum(L.spend),
    unbudgetedSpend: toNum(L.unbudgetedSpend),
    orphanSpend: toNum(orphanSpend),
    utilizationBp: toNum(utilBp),
    thresholdsCrossed: crossed,
    forecastAtCompletion: toNum(eac),
    forecastVsBudget: toNum(eac - target),
    funding: toNum(L.funding),
    revenue: toNum(L.revenue),
    net: toNum(net),
    marginBp: L.revenue > 0n ? toNum(divRound(net * BP, L.revenue)) : null,
    cashPosition: toNum(L.inflows - L.outflows),
    status,
    lines: variances,
  };
}

// ---------- alerts ----------

/**
 * Which alerts should exist for the current health, and which stored ones no longer apply.
 * Keys are stable, so one threshold fires once per estimate revision:
 *   budget:<pct>:<estimateId>   forecast:<estimateId>   line:<lineKey>:<estimateId>
 * Stored keys belonging to this revision that are no longer true are returned in `clear`, which re-arms them.
 * Pure: the Worker writes `create` with a "document must not exist" precondition, so a race fires once.
 */
export function alertsFor(health, estimateId, storedKeys = []) {
  const wanted = new Map();
  for (const p of health.thresholdsCrossed) {
    const key = `budget:${p}:${estimateId}`;
    wanted.set(key, { rule: "budget_threshold", severity: p >= 100 ? "critical" : "warning", thresholdPct: p, dedupeKey: key });
  }
  if (health.forecastVsBudget > 0) {
    const key = `forecast:${estimateId}`;
    wanted.set(key, { rule: "forecast_overrun", severity: "critical", dedupeKey: key });
  }
  for (const v of health.lines) {
    if (v.status !== "warning" && v.status !== "over_budget") continue;
    const key = `line:${v.lineKey}:${estimateId}`;
    wanted.set(key, { rule: "line_overrun", severity: v.status === "over_budget" ? "critical" : "warning", lineKey: v.lineKey, dedupeKey: key });
  }

  const stored = new Set(storedKeys);
  const create = [...wanted.values()].filter((a) => !stored.has(a.dedupeKey));
  const clear = storedKeys.filter((k) => k.endsWith(`:${estimateId}`) && !wanted.has(k));
  return { create, clear };
}

// ---------- estimate and project lifecycle ----------

// Only a draft revision accepts edits. The baseline is frozen; changes go into a new draft (a change order).
export function assertEstimateEditable(estimate) {
  if (estimate.status !== "draft") throw new PfmError("baseline_locked", `estimate is ${estimate.status}`);
}

export function assertCanApprove(estimate, lines, project) {
  if (estimate.status !== "draft") throw new PfmError("not_draft", `estimate is ${estimate.status}`);
  if (!lines.length) throw new PfmError("empty_estimate", "add at least one line");
  if (!["planning", "active"].includes(project.status)) throw new PfmError("bad_project_status", project.status);
  assertUniqueLineKeys(lines);
  return true;
}

export function nextRevision(estimates) {
  return estimates.reduce((m, e) => Math.max(m, e.revision), 0) + 1;
}

export function assertProjectTransition(from, to) {
  if (!PROJECT_STATUS_TRANSITIONS[from]?.includes(to)) throw new PfmError("bad_transition", `${from} -> ${to}`);
  return true;
}

// ---------- sharing ----------

// viewer reads; editor changes entries, estimates and alerts; owner also manages members, invites and deletion.
export const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });
export const SHARE_ROLES = Object.freeze(["viewer", "editor"]);   // what an invite can grant (owner is never granted)
export const INVITE_MAX_USES = 10;
export const INVITE_DAYS = { default: 7, max: 30 };
export function assertRole(role, need) {
  if (!(role in ROLE_RANK) || ROLE_RANK[role] < ROLE_RANK[need]) throw new PfmError("forbidden", `${need} role needed`);
  return true;
}

// ---------- charts (data only; the app and the export draw them) ----------

/**
 * lines: [{ lineKey, category, estTotal }]   txs: stored or validated ledger rows
 * Returns the series for the charts. Money is in minor units, dates are YYYY-MM-DD.
 *   byCategory: estimate vs actual for each BOQ category (an expense without a line counts under its own category)
 *   byMonth:    actual spend and inflows per month
 *   daily:      inflows, outflows and the running balance per day (loan repayments count as outflows)
 */
export function chartSeries(lines, txs) {
  const catOf = new Map(lines.map((l) => [l.lineKey, BOQ_CATEGORIES.includes(l.category) ? l.category : "other"]));
  const byCat = Object.fromEntries(BOQ_CATEGORIES.map((c) => [c, { category: c, estimated: 0, actual: 0 }]));
  for (const l of lines) byCat[catOf.get(l.lineKey)].estimated += Number(l.estTotal);

  const months = new Map(), days = new Map();
  for (const x of txs) {
    if (x.status === "voided") continue;
    const amt = Number(x.amount), d = x.occurredOn, m = d.slice(0, 7);
    if (x.kind === "expense") {
      const cat = x.lineKey ? catOf.get(x.lineKey) ?? "other" : (BOQ_CATEGORIES.includes(x.category) ? x.category : "other");
      byCat[cat].actual += amt;
    }
    const mo = months.get(m) ?? { month: m, actual: 0, inflow: 0 };
    if (x.kind === "expense") mo.actual += amt;
    if (x.direction === "inflow") mo.inflow += amt;
    months.set(m, mo);
    const dy = days.get(d) ?? { date: d, inflow: 0, outflow: 0 };
    if (x.direction === "inflow") dy.inflow += amt; else dy.outflow += amt;
    days.set(d, dy);
  }
  let balance = 0;
  const daily = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((dy) => {
    balance += dy.inflow - dy.outflow;
    return { ...dy, balance };
  });
  return {
    byCategory: BOQ_CATEGORIES.map((c) => byCat[c]),
    byMonth: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    daily,
  };
}

// Firestore paths, relative to the document root (the Worker adds the root when it writes).
// Projects are shared, so they live at the top level; each user keeps an index of the projects they belong to.
export const paths = Object.freeze({
  meta: (uid) => `pfm/${uid}/meta/projects`,
  indexes: (uid) => `pfm/${uid}/projectIndex`,
  index: (uid, pid) => `pfm/${uid}/projectIndex/${pid}`,
  project: (pid) => `pfmProjects/${pid}`,
  members: (pid) => `pfmProjects/${pid}/members`,
  member: (pid, uid) => `pfmProjects/${pid}/members/${uid}`,
  estimates: (pid) => `pfmProjects/${pid}/estimates`,
  estimate: (pid, eid) => `pfmProjects/${pid}/estimates/${eid}`,
  lines: (pid, eid) => `pfmProjects/${pid}/estimates/${eid}/lines`,
  tx: (pid) => `pfmProjects/${pid}/tx`,
  alerts: (pid) => `pfmProjects/${pid}/alerts`,
  invite: (token) => `pfmInvites/${token}`,
  files: (pid) => `pfmProjects/${pid}/files`,
  file: (pid, fid) => `pfmProjects/${pid}/files/${fid}`,
  parts: (pid, fid) => `pfmProjects/${pid}/files/${fid}/parts`,
});
