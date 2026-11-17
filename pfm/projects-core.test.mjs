// Usage: node pfm/projects-core.test.mjs
import assert from "node:assert/strict";
import * as J from "./projects-core.mjs";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

const SDG_PROJECT = { name: "House", template: "house_construction", currency: "SDG", targetBudget: "3,000.00" };
const proj = J.validateProjectInput(SDG_PROJECT);

t("validateProjectInput: accepts a clean project and fills defaults", () => {
  assert.equal(proj.targetBudget, 300000);
  assert.deepEqual(proj.alertThresholdsPct, [80, 100]);
  assert.equal(proj.lineTolerancePct, 5);
  assert.equal(proj.status, "planning");
});

t("validateProjectInput: refuses bad input with stable codes", () => {
  const bad = (over, code) => assert.throws(() => J.validateProjectInput({ ...SDG_PROJECT, ...over }), { code });
  bad({ currency: "EUR" }, "bad_currency");
  bad({ template: "wedding" }, "bad_template");
  bad({ targetBudget: "0" }, "bad_budget");
  bad({ targetBudget: "10.005" }, "too_precise");
  bad({ startDate: "2026-02-30" }, "bad_date");
  bad({ startDate: "2026-06-10", endDate: "2026-06-01" }, "bad_dates");
  bad({ alertThresholdsPct: [100, 80] }, "bad_thresholds");
  bad({ lineTolerancePct: 101 }, "bad_tolerance");
  bad({ name: "   " }, "bad_name");
});

t("validateProjectInput: KWD keeps three decimals, JPY none", () => {
  assert.equal(J.validateProjectInput({ ...SDG_PROJECT, currency: "KWD", targetBudget: "12.345" }).targetBudget, 12345);
  assert.equal(J.validateProjectInput({ ...SDG_PROJECT, currency: "JPY", targetBudget: "500000" }).targetBudget, 500000);
});

t("qtyText: canonical decimal text", () => {
  assert.equal(J.qtyText(2500n), "2.5");
  assert.equal(J.qtyText(10000n), "10");
  assert.equal(J.qtyText(1n), "0.001");
  assert.equal(J.qtyText(-500n), "-0.5");
});

t("validateBoqLine + lineTotal: rounds half away from zero", () => {
  const l = J.validateBoqLine({ lineKey: "rebar", category: "raw_materials", name: "Rebar", unit: "ton", estQty: "2.5", estUnitPrice: "19.99" }, "SDG");
  assert.equal(l.estQty, 2500n);
  assert.equal(l.estUnitPrice, 1999);
  assert.equal(l.estTotal, 4998);                    // 2.5 × 19.99 = 49.975 → 49.98
  assert.throws(() => J.validateBoqLine({ lineKey: "x", category: "labor", name: "x", unit: "hr", estQty: "0", estUnitPrice: "1" }, "SDG"), { code: "bad_qty" });
  assert.throws(() => J.validateBoqLine({ lineKey: "x", category: "fun", name: "x", unit: "hr", estQty: "1", estUnitPrice: "1" }, "SDG"), { code: "bad_category" });
  assert.throws(() => J.validateBoqLine({ lineKey: "bad key!", category: "labor", name: "x", unit: "hr", estQty: "1", estUnitPrice: "1" }, "SDG"), { code: "bad_line_key" });
});

const cement = J.validateBoqLine({ lineKey: "cement", category: "raw_materials", name: "Cement", unit: "bag", estQty: "100", estUnitPrice: "10" }, "SDG");
const labor = J.validateBoqLine({ lineKey: "mason", category: "labor", name: "Mason", unit: "day", estQty: "30", estUnitPrice: "45" }, "SDG");

t("estimateTotals: total and per category", () => {
  const e = J.estimateTotals([cement, labor]);
  assert.equal(e.total, 100000 + 135000);
  assert.deepEqual(e.byCategory, { raw_materials: 100000, labor: 135000 });
});

t("lineVariance: the worked example (110 bags at 11.00 against 100 at 10.00)", () => {
  const v = J.lineVariance(cement, { qty: J.validateBoqLine({ lineKey: "a", category: "other", name: "a", unit: "b", estQty: "110", estUnitPrice: "1" }, "SDG").estQty, cost: 121000 }, 5);
  assert.equal(v.qtyVariance, "10");
  assert.equal(v.qtyVariancePct, 10);
  assert.equal(v.actualUnitPrice, 1100);
  assert.equal(v.quantityEffect, 10000);             // 10 extra bags × 10.00
  assert.equal(v.priceEffect, 11000);                // +1.00 per bag × 110 bags
  assert.equal(v.totalVariance, 21000);
  assert.equal(v.quantityEffect + v.priceEffect, v.totalVariance);
  assert.equal(v.status, "over_budget");             // 1210.00 > 1000.00 × 1.05
});

t("lineVariance: effects always add up, even with rounding", () => {
  for (const [q, price, cost] of [["3", "7.77", 2333], ["0.333", "100", 1], ["12.5", "0.01", 99], ["1", "5", 0]]) {
    const line = J.validateBoqLine({ lineKey: "k", category: "other", name: "k", unit: "u", estQty: q, estUnitPrice: price }, "SDG");
    const v = J.lineVariance(line, { qty: line.estQty, cost }, 5);
    assert.equal(v.quantityEffect + v.priceEffect, v.totalVariance, `${q} × ${price} vs ${cost}`);
  }
});

t("lineVariance: statuses and tolerance", () => {
  const st = (cost) => J.lineVariance(cement, { qty: 100000n, cost }, 5).status;
  assert.equal(st(0), "not_started");
  assert.equal(st(100000), "on_budget");
  assert.equal(st(102000), "warning");              // above estimate, within 5 %
  assert.equal(st(105000), "warning");              // exactly at the tolerance edge
  assert.equal(st(105001), "over_budget");
});

// A project: budget 3,000.00 SDG. Cement line estimated at 1,000.00. Mason line estimated at 1,350.00.
const lines = [cement, labor];
const tx = (over) => ({ status: "posted", ...J.validateProjectTx({ occurredOn: "2026-11-02", description: "x", ...over }, proj) });
const ledger = [
  tx({ kind: "capital_injection", amount: "5,000.00", description: "Owner" }),
  tx({ kind: "revenue", amount: "2,000.00", description: "Sale" }),
  tx({ kind: "expense", amount: "1,210.00", lineKey: "cement", quantity: "110", unit: "bag", description: "Cement" }),
  tx({ kind: "expense", amount: "400.00", category: "other", description: "Transport" }),
  tx({ kind: "loan_repayment", amount: "300.00", description: "Bank" }),
  { ...tx({ kind: "expense", amount: "999.99", category: "other", description: "Voided" }), status: "voided" },
];

t("projectHealth: totals, margin and cash position", () => {
  const h = J.projectHealth(proj, lines, ledger);
  assert.equal(h.actualSpend, 161000);               // 1,210 + 400; the voided row and the loan repayment are excluded
  assert.equal(h.unbudgetedSpend, 40000);
  assert.equal(h.utilizationBp, 5367);               // 161,000 ÷ 300,000 = 53.67 %
  assert.deepEqual(h.thresholdsCrossed, []);
  assert.equal(h.forecastAtCompletion, 121000 + 135000 + 40000); // cement over its estimate, mason untouched at its estimate, plus transport
  assert.equal(h.revenue, 200000);
  assert.equal(h.net, 39000);
  assert.equal(h.marginBp, 1950);                    // 390 ÷ 2,000 = 19.5 %
  assert.equal(h.cashPosition, 700000 - (121000 + 40000 + 30000));
  assert.equal(h.status, "green");
  assert.equal(h.budgetGap, 300000 - 235000);
});

t("projectHealth: amber at the first threshold, red at 100 % or a forecast over budget", () => {
  // Mason spent 850.00 of his 1,350.00 estimate: spend 2,460 (82 %), forecast 2,960 (inside 3,000) → amber
  const masonSpend = tx({ kind: "expense", amount: "850.00", lineKey: "mason", description: "Mason week 1" });
  const amber = J.projectHealth(proj, lines, [...ledger, masonSpend]);
  assert.equal(amber.utilizationBp, 8200);
  assert.equal(amber.forecastAtCompletion, 121000 + 135000 + 40000);
  assert.equal(amber.status, "amber");
  assert.deepEqual(amber.thresholdsCrossed, [80]);
  // Untouched estimates count in the forecast, so spending well under budget can still forecast over it
  const red = J.projectHealth(proj, lines, [...ledger, tx({ kind: "expense", amount: "1,500.00", category: "other", description: "more" })]);
  assert.equal(red.status, "red");
  assert.deepEqual(red.thresholdsCrossed, [80, 100]);
});

t("alertsFor: fires each threshold once and clears when it stops applying", () => {
  const h = J.projectHealth(proj, lines, [...ledger, tx({ kind: "expense", amount: "1,500.00", category: "other", description: "x" })]);
  const first = J.alertsFor(h, "rev1", []);
  const keys = first.create.map((a) => a.dedupeKey).sort();
  assert.ok(keys.includes("budget:80:rev1") && keys.includes("budget:100:rev1") && keys.includes("forecast:rev1"));
  assert.equal(first.create.find((a) => a.dedupeKey === "budget:100:rev1").severity, "critical");
  assert.ok(first.create.some((a) => a.rule === "line_overrun" && a.lineKey === "cement" && a.severity === "critical"));

  // Second run with those keys stored: nothing new to create, nothing to clear
  const again = J.alertsFor(h, "rev1", keys);
  assert.deepEqual(again.create, []);
  assert.deepEqual(again.clear, []);

  // A budget raise drops utilisation below both thresholds: they are cleared, so they can fire again later
  const calm = J.projectHealth({ ...proj, targetBudget: 900000 }, lines, [...ledger, tx({ kind: "expense", amount: "1,500.00", category: "other", description: "x" })]);
  const cleared = J.alertsFor(calm, "rev1", keys);
  assert.deepEqual(calm.thresholdsCrossed, []);
  assert.ok(cleared.clear.includes("budget:80:rev1") && cleared.clear.includes("budget:100:rev1"));
});

t("alertsFor: alerts from an older revision are never cleared by a newer one", () => {
  const h = J.projectHealth(proj, lines, ledger);
  assert.deepEqual(J.alertsFor(h, "rev2", ["budget:80:rev1"]).clear, []);
});

t("validateProjectTx: direction, foreign currency with a typed rate, and line rules", () => {
  const e = J.validateProjectTx({ kind: "expense", amount: "12.50", lineKey: "cement", quantity: "2.5", unit: "bag", occurredOn: "2026-11-03", description: "Cement" }, proj);
  assert.equal(e.direction, "outflow");
  assert.equal(e.amount, 1250);
  assert.equal(e.quantity, 2500n);
  const usd = J.validateProjectTx({ kind: "capital_injection", amount: "100", currency: "USD", fxRate: "600", occurredOn: "2026-11-03", description: "Loan" }, proj);
  assert.equal(usd.amount, 6000000);                 // 100.00 USD × 600 = 60,000.00 SDG
  assert.equal(usd.originalAmount, 10000);
  assert.throws(() => J.validateProjectTx({ kind: "capital_injection", amount: "100", currency: "USD", occurredOn: "2026-11-03", description: "x" }, proj), { code: "fx_rate_required" });
  assert.throws(() => J.validateProjectTx({ kind: "revenue", amount: "5", lineKey: "cement", occurredOn: "2026-11-03", description: "x" }, proj), { code: "line_on_non_expense" });
  assert.throws(() => J.validateProjectTx({ kind: "expense", amount: "5", occurredOn: "2026-11-03", description: "x" }, proj), { code: "bad_category" });
  assert.throws(() => J.validateProjectTx({ kind: "gift", amount: "5", occurredOn: "2026-11-03", description: "x" }, proj), { code: "bad_kind" });
});

t("lifecycle: baseline is frozen, approval needs lines, transitions are whitelisted", () => {
  assert.throws(() => J.assertEstimateEditable({ status: "baseline" }), { code: "baseline_locked" });
  assert.doesNotThrow(() => J.assertEstimateEditable({ status: "draft" }));
  assert.throws(() => J.assertCanApprove({ status: "draft" }, [], proj), { code: "empty_estimate" });
  assert.throws(() => J.assertCanApprove({ status: "draft" }, [cement, cement], proj), { code: "dup_line_key" });
  assert.equal(J.assertCanApprove({ status: "draft" }, lines, proj), true);
  assert.throws(() => J.assertProjectTransition("planning", "completed"), { code: "bad_transition" });
  assert.equal(J.assertProjectTransition("active", "completed"), true);
  assert.equal(J.nextRevision([{ revision: 1 }, { revision: 3 }]), 4);
  assert.equal(J.nextRevision([]), 1);
});

t("chartSeries: categories, months and a running balance; voided rows and loan repayments handled", () => {
  const lines = [{ lineKey: "a", category: "raw_materials", estTotal: 1000 }, { lineKey: "b", category: "labor", estTotal: 500 }];
  const rows = [
    { kind: "capital_injection", direction: "inflow", amount: 2000, occurredOn: "2026-10-30", status: "posted" },
    { kind: "expense", direction: "outflow", amount: 1200, lineKey: "a", occurredOn: "2026-11-02", status: "posted" },
    { kind: "expense", direction: "outflow", amount: 300, category: "other", occurredOn: "2026-11-02", status: "posted" },
    { kind: "expense", direction: "outflow", amount: 999, lineKey: "b", occurredOn: "2026-11-03", status: "voided" },
    { kind: "loan_repayment", direction: "outflow", amount: 400, occurredOn: "2026-11-03", status: "posted" },
  ];
  const c = J.chartSeries(lines, rows);
  assert.deepEqual(c.byCategory.map((x) => [x.category, x.estimated, x.actual]), [["raw_materials", 1000, 1200], ["labor", 500, 0], ["equipment_rental", 0, 0], ["permits", 0, 0], ["other", 0, 300]]);
  assert.deepEqual(c.byMonth.map((m) => [m.month, m.actual, m.inflow]), [["2026-10", 0, 2000], ["2026-11", 1500, 0]]);
  assert.deepEqual(c.daily.map((d) => [d.date, d.balance]), [["2026-10-30", 2000], ["2026-11-02", 500], ["2026-11-03", 100]]);
});

console.log(process.exitCode ? "FAILED" : `projects-core: ${n} passed`);
