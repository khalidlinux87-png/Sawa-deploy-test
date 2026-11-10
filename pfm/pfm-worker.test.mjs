// End-to-end tests of the pfm.* Worker ops against an in-memory Firestore.
// Usage: node pfm/pfm-worker.test.mjs
// toFsValue / fsToJs are taken from worker-3.js itself, so a format mismatch with the real Worker shows up here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlePfmOp, purgePfm, PFM_OPS } from "./pfm-worker.mjs";
import * as C from "./pfm-core.mjs";

const src = readFileSync(new URL("../worker-3.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf("function " + name + "("); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return src.slice(a, i + 1); };
const { toFsValue, fsToJs } = new Function(grab("toFsValue") + grab("fsToJs") + "; return { toFsValue, fsToJs };")();

import { makeFs as makeFsWith, ROOT } from "./fake-firestore.mjs";
const makeFs = () => makeFsWith(toFsValue, fsToJs);

const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
function setup() {
  const fs = makeFs();
  const d = { DOC_ROOT: ROOT, toFsValue, fsToJs, getToken: async () => "tok", ...fs,
    fsGet: fs.fsGet, fsList: fs.fsList, fsQuerySub: fs.fsQuerySub, fsCommit: (...a) => fs.fsCommit(...a) };
  const env = { PFM_KEK_v1: KEK };
  const call = (op, payload, uid = "u1") => handlePfmOp(op, uid, payload, env, d);
  return { fs, d, env, call };
}
const month = (fs, uid, m) => fs.docs.get(`${ROOT}/pfm/${uid}/months/${m}`)?.data || {};
const err = (code) => (e) => { assert.match(e.message, new RegExp("^" + code)); return true; };

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

await t("not configured without the encryption key; not initialised before init", async () => {
  const { d, call } = setup();
  await assert.rejects(handlePfmOp("pfm.get", "u1", {}, {}, d), err("pfm_not_configured"));
  assert.deepEqual(await call("pfm.get"), { settings: null });
  await assert.rejects(call("pfm.tx.list", {}), err("pfm_not_initialised"));
  await assert.rejects(call("pfm.nope", {}), /unknown op/);
});

await t("init: validates, seeds categories, is idempotent, starts the audit chain", async () => {
  const { fs, call } = setup();
  await assert.rejects(call("pfm.init", { baseCurrency: "XXQ", tz: "Europe/Berlin" }), err("bad_currency"));
  await assert.rejects(call("pfm.init", { baseCurrency: "GBP", tz: "Mars/Base" }), err("bad_tz"));
  const r = await call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin", locale: "en" });
  assert.equal(r.settings.baseCurrency, "GBP");
  assert.equal(r.categories.length, C.DEFAULT_CATEGORIES.length);
  assert.match(r.month, /^\d{4}-\d{2}$/);
  const again = await call("pfm.init", { baseCurrency: "USD", tz: "UTC" });
  assert.equal(again.settings.baseCurrency, "GBP");                       // second init changes nothing
  assert.equal(fs.docs.get(`${ROOT}/audit/u1`).data.headSeq, 1);
});

async function ready(opts = {}) {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin", ...opts });
  return s;
}

await t("tx.add: base currency, rollups, encryption at rest, idempotency", async () => {
  const { fs, call } = await ready();
  const a = await call("pfm.tx.add", { idemKey: "key-0000001", kind: "expense", amount: "12.50", categoryId: "c_food", date: "2026-11-05", note: "Lunch with Sara", counterparty: "Café" });
  assert.equal(a.tx.amount, 1250); assert.equal(a.tx.baseAmount, 1250); assert.equal(a.tx.note, "Lunch with Sara");
  const stored = fs.docs.get(`${ROOT}/pfm/u1/tx/t_key-0000001`).data;
  assert.match(stored.note, /^v1:1:/); assert.ok(!JSON.stringify(stored).includes("Sara"));   // sealed at rest
  const commits = fs.commits;
  const again = await call("pfm.tx.add", { idemKey: "key-0000001", kind: "expense", amount: "99", categoryId: "c_food", date: "2026-11-05" });
  assert.equal(again.tx.amount, 1250); assert.equal(fs.commits, commits);          // a retry is a no-op
  await call("pfm.tx.add", { idemKey: "key-0000002", kind: "income", amount: "2000", categoryId: "c_salary", date: "2026-11-01" });
  const m = month(fs, "u1", "2026-11");
  assert.equal(m.expense, 1250); assert.equal(m.income, 200000); assert.equal(m.txCount, 2);
  assert.equal(m.cat.c_food.e, 1250); assert.equal(m.day.d05.e, 1250);
  assert.equal(fs.docs.get(`${ROOT}/pfm/u1`).data.hasTx, true);
});

await t("tx.add: validation", async () => {
  const { call } = await ready();
  const base = { idemKey: "key-0000009", kind: "expense", amount: "5", categoryId: "c_food", date: "2026-11-05" };
  await assert.rejects(call("pfm.tx.add", { ...base, idemKey: "x" }), err("bad_idem_key"));
  await assert.rejects(call("pfm.tx.add", { ...base, amount: "0" }), err("bad_amount"));
  await assert.rejects(call("pfm.tx.add", { ...base, amount: "1.005" }), err("too_precise"));
  await assert.rejects(call("pfm.tx.add", { ...base, categoryId: "c_salary" }), err("category_kind_mismatch"));
  await assert.rejects(call("pfm.tx.add", { ...base, categoryId: "nope" }), err("bad_category"));
  await assert.rejects(call("pfm.tx.add", { ...base, date: "2026-13-01" }), err("bad_date"));
  await assert.rejects(call("pfm.tx.add", { ...base, note: "x".repeat(301) }), err("too_long"));
  await assert.rejects(call("pfm.tx.add", { ...base, currency: "CNY", amount: "1.555" }), err("too_precise"));
});

await t("foreign currency: typed rate, pending rate, last-rate memory", async () => {
  const { fs, call } = await ready();
  const a = await call("pfm.tx.add", { idemKey: "key-usd-0001", kind: "expense", amount: "25.00", currency: "USD", fxRate: "0.9224", categoryId: "c_telecom", date: "2026-11-03" });
  assert.equal(a.tx.baseAmount, 2306); assert.equal(a.tx.fxSource, "manual");
  assert.deepEqual(await call("pfm.fx.last", { from: "USD" }).then((r) => [r.to, r.rate]), ["GBP", "0.9224"]);
  const b = await call("pfm.tx.add", { idemKey: "key-usd-0002", kind: "expense", amount: "10", currency: "USD", categoryId: "c_telecom", date: "2026-11-04" });
  assert.equal(b.tx.baseAmount, null); assert.equal(b.tx.fxSource, "pending");
  let m = month(fs, "u1", "2026-11");
  assert.equal(m.expense, 2306); assert.equal(m.ratePending, 1);
  // adding the rate later moves it from pending into the totals
  await call("pfm.tx.update", { id: b.tx.id, rev: 1, fxRate: "0.92" });
  m = month(fs, "u1", "2026-11");
  assert.equal(m.expense, 2306 + 920); assert.equal(m.ratePending, 0);
  const y = await call("pfm.tx.add", { idemKey: "key-jpy-0001", kind: "expense", amount: "1500", currency: "CNY", fxRate: "0.0061", categoryId: "c_food", date: "2026-11-04" });
  assert.equal(y.tx.amount, 150000); assert.equal(y.tx.baseAmount, 915);        // ¥1,500.00 × 0.0061 = £9.15
});

await t("tx.update and tx.delete keep rollups exact, with stale-write protection", async () => {
  const { fs, call } = await ready();
  const a = await call("pfm.tx.add", { idemKey: "key-edit-001", kind: "expense", amount: "40", categoryId: "c_food", date: "2026-11-05" });
  await assert.rejects(call("pfm.tx.update", { id: a.tx.id, rev: 7, amount: "50" }), err("stale"));
  const u = await call("pfm.tx.update", { id: a.tx.id, rev: 1, amount: "50", categoryId: "c_transport", date: "2026-10-30", note: "taxi" });
  assert.equal(u.tx.rev, 2); assert.equal(u.tx.note, "taxi");
  const nov = month(fs, "u1", "2026-11"), oct = month(fs, "u1", "2026-10");
  assert.equal(nov.expense, 0); assert.equal(nov.cat.c_food.e, 0); assert.equal(nov.txCount, 0);
  assert.equal(oct.expense, 5000); assert.equal(oct.cat.c_transport.e, 5000);
  // an update that changes nothing writes nothing
  const commits = fs.commits;
  await call("pfm.tx.update", { id: a.tx.id, rev: 2, amount: "50" });
  assert.equal(fs.commits, commits);
  await call("pfm.tx.delete", { id: a.tx.id, rev: 2 });
  assert.equal(month(fs, "u1", "2026-10").expense, 0);
  await assert.rejects(call("pfm.tx.delete", { id: a.tx.id, rev: 3 }), err("not_found"));
  assert.equal((await call("pfm.tx.list", { month: "2026-10" })).items.length, 0);
});

await t("tx.list: newest first, decrypted, filtered, scoped to the user", async () => {
  const { call } = await ready();
  await call("pfm.tx.add", { idemKey: "key-list-001", kind: "expense", amount: "1", categoryId: "c_food", date: "2026-11-02", note: "a" });
  await call("pfm.tx.add", { idemKey: "key-list-002", kind: "expense", amount: "2", categoryId: "c_rent", date: "2026-11-09" });
  await call("pfm.tx.add", { idemKey: "key-list-003", kind: "income", amount: "3", categoryId: "c_salary", date: "2026-11-05" });
  const r = await call("pfm.tx.list", { month: "2026-11" });
  assert.deepEqual(r.items.map((i) => i.date), ["2026-11-09", "2026-11-05", "2026-11-02"]);
  assert.equal(r.items[2].note, "a");
  assert.equal((await call("pfm.tx.list", { month: "2026-11", categoryId: "c_rent" })).items.length, 1);
  await assert.rejects(call("pfm.tx.list", { month: "2026-11" }, "u2"), err("pfm_not_initialised"));   // another user sees nothing
});

await t("month start day assigns rows to budget months and locks after the first entry", async () => {
  const { fs, call } = await ready({ monthStartDay: 25 });
  await call("pfm.tx.add", { idemKey: "key-msd-0001", kind: "expense", amount: "10", categoryId: "c_food", date: "2026-11-24" });
  await call("pfm.tx.add", { idemKey: "key-msd-0002", kind: "expense", amount: "20", categoryId: "c_food", date: "2026-11-25" });
  assert.equal(month(fs, "u1", "2026-10").expense, 1000); assert.equal(month(fs, "u1", "2026-11").expense, 2000);
  await assert.rejects(call("pfm.settings.set", { monthStartDay: 1 }), err("locked_after_first_entry"));
  await assert.rejects(call("pfm.settings.set", { baseCurrency: "USD" }), err("locked_after_first_entry"));
  const r = await call("pfm.settings.set", { tz: "Asia/Riyadh", locale: "ar" });
  assert.equal(r.settings.tz, "Asia/Riyadh");
});

await t("settings can change freely before the first entry", async () => {
  const { call } = await ready();
  const r = await call("pfm.settings.set", { baseCurrency: "SAR", monthStartDay: 27 });
  assert.equal(r.settings.baseCurrency, "SAR"); assert.equal(r.settings.monthStartDay, 27);
});

await t("categories: add, rename, fixed kind, archive", async () => {
  const { call } = await ready();
  const c = await call("pfm.cat.upsert", { name: "Coffee", nameAr: "قهوة", kind: "expense", color: "#7c2d12", icon: "cup" });
  assert.match(c.category.id, /^u_/);
  const r = await call("pfm.cat.upsert", { id: c.category.id, name: "Coffee & tea", kind: "income" });
  assert.equal(r.category.name, "Coffee & tea"); assert.equal(r.category.kind, "expense");
  await assert.rejects(call("pfm.cat.upsert", { name: "X", kind: "both" }), err("bad_kind"));
  await assert.rejects(call("pfm.cat.upsert", { name: "X", kind: "expense", color: "red" }), err("bad_color"));
  await call("pfm.tx.add", { idemKey: "key-cat-0001", kind: "expense", amount: "3", categoryId: c.category.id, date: "2026-11-05" });
  await call("pfm.cat.archive", { id: c.category.id });
  await assert.rejects(call("pfm.tx.add", { idemKey: "key-cat-0002", kind: "expense", amount: "3", categoryId: c.category.id, date: "2026-11-05" }), err("category_archived"));
  const g = await call("pfm.get");
  assert.equal(g.categories.find((x) => x.id === c.category.id).archived, true);
});

await t("summary: months, savings rate, category shares, daily series", async () => {
  const { call } = await ready();
  await call("pfm.tx.add", { idemKey: "key-sum-0001", kind: "income", amount: "3000", categoryId: "c_salary", date: "2026-11-01" });
  await call("pfm.tx.add", { idemKey: "key-sum-0002", kind: "expense", amount: "900", categoryId: "c_rent", date: "2026-11-01" });
  await call("pfm.tx.add", { idemKey: "key-sum-0003", kind: "expense", amount: "300", categoryId: "c_food", date: "2026-11-07" });
  await call("pfm.tx.add", { idemKey: "key-sum-0004", kind: "expense", amount: "100", categoryId: "c_food", date: "2026-10-07" });
  const s = await call("pfm.summary", { from: "2026-09", to: "2026-11" });
  assert.deepEqual(s.months.map((m) => [m.month, m.net]), [["2026-09", 0], ["2026-10", -10000], ["2026-11", 180000]]);
  assert.equal(s.focus.savingsRateBp, 6000);
  assert.deepEqual(s.focus.byCategory.map((c) => [c.categoryId, c.shareBp]), [["c_rent", 7500], ["c_food", 2500], ["c_salary", 0]]);
  assert.deepEqual(s.focus.days.map((x) => x.day), [1, 7]);
  await assert.rejects(call("pfm.summary", { from: "2024-01", to: "2026-11" }), err("range_too_long"));
});

await t("audit: every change logged, chain verifies, tampering detected", async () => {
  const { fs, call } = await ready();
  const a = await call("pfm.tx.add", { idemKey: "key-aud-0001", kind: "expense", amount: "5", categoryId: "c_food", date: "2026-11-05" });
  await call("pfm.tx.update", { id: a.tx.id, rev: 1, amount: "6" });
  await call("pfm.tx.delete", { id: a.tx.id, rev: 2 });
  const r = await call("pfm.audit.list", {});
  assert.deepEqual(r.entries.map((e) => e.action), ["tx.delete", "tx.update", "tx.add", "pfm.init"]);
  assert.equal(r.verified, true); assert.equal(r.headSeq, 4);
  assert.deepEqual(r.entries[1].before, { amount: 500, baseAmount: 500 });
  // Full chain check straight from storage
  const log = [...fs.docs].filter(([k]) => k.includes("/audit/u1/log/")).sort().map(([, e]) => e.data);
  assert.equal((await C.verifyChain(log)).ok, true);
  // someone edits a stored entry: the window check fails
  fs.docs.get(`${ROOT}/audit/u1/log/0000000002`).data.after.amount = 1;
  assert.equal((await call("pfm.audit.list", {})).verified, false);
});

await t("concurrent writes: the audit head precondition forces a clean retry", async () => {
  const { fs, d, env } = await ready();
  // Two adds race: both read the same audit head; one commit must fail and retry on top of the other.
  const real = fs.fsCommit.bind(fs); let gate = null;
  d.fsCommit = async (tk, w) => { if (!gate) { gate = 1; await new Promise((r) => setTimeout(r, 5)); } return real(tk, w); };
  await Promise.all(["key-race-001", "key-race-002"].map((k) => handlePfmOp("pfm.tx.add", "u1", { idemKey: k, kind: "expense", amount: "1", categoryId: "c_food", date: "2026-11-05" }, env, d)));
  const log = [...fs.docs].filter(([k]) => k.includes("/audit/u1/log/")).sort().map(([, e]) => e.data);
  assert.equal(log.length, 3); assert.equal((await C.verifyChain(log)).ok, true);
  assert.equal(month(fs, "u1", "2026-11").expense, 200);
});

await t("account deletion removes everything", async () => {
  const { fs, d, call } = await ready();
  await call("pfm.tx.add", { idemKey: "key-del-0001", kind: "expense", amount: "5", categoryId: "c_food", date: "2026-11-05", currency: "USD", fxRate: "0.9" });
  const purgeColl = async (_t, rel, spend) => { for (const x of await fs.fsList(null, rel)) { if (!spend()) return false; await fs.fsCommit(null, [{ delete: x.name }]); } return true; };
  assert.equal(await purgePfm(d, "tok", "u1", () => true, purgeColl), true);
  assert.deepEqual([...fs.docs.keys()].filter((k) => k.includes("/u1")), []);
});

// ========================= P2 =========================
import { pfmCron } from "./pfm-worker.mjs";
const TODAY = C.localDate("Europe/Berlin"), MONTH = C.budgetMonth(TODAY), PREV = (() => { const [y, m] = MONTH.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); })();
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
async function ready2(opts) {
  const r = await ready(opts); r.pushes = []; r.d.push = async (_t, uid, title, body) => { r.pushes.push({ uid, title, body }); return 1; };
  r.d.runQuery = r.fs.runQuery; return r;
}
let seq = 0; const k = () => "key-p2-" + String(++seq).padStart(5, "0");
const spend = (call, amount, cat = "c_food", date = TODAY, extra = {}) => call("pfm.tx.add", { idemKey: k(), kind: "expense", amount, categoryId: cat, date, ...extra });

await t("budgets: each threshold alerts once, one push per budget per write, old months never alert", async () => {
  const { fs, call, pushes } = await ready2();
  await call("pfm.budget.set", { categoryId: "c_food", limit: "100" });
  const a = await spend(call, "85");
  assert.deepEqual(a.alerts.filter((x) => x.kind === "threshold").map((x) => x.bp), [5000, 8000]);
  assert.equal(pushes.length, 1); assert.match(pushes[0].title, /طعام ومشتريات/);   // one push, the most serious alert
  const b = await spend(call, "1");
  assert.deepEqual(b.alerts.filter((x) => x.kind === "threshold"), []); assert.equal(pushes.length, 1);
  const c = await spend(call, "20");
  assert.deepEqual(c.alerts.map((x) => x.bp), [10000]); assert.match(pushes[1].title, /تجاوزت/);
  const old = await spend(call, "500", "c_food", PREV + "-15");
  assert.deepEqual(old.alerts, []); assert.equal(pushes.length, 2);
  const ids = [...fs.docs.keys()].filter((n) => n.includes("/alerts/")).map((n) => n.split("/").pop()).filter((n) => !n.endsWith("_pace")).sort();
  assert.deepEqual(ids, [`${MONTH}_c_food_10000`, `${MONTH}_c_food_5000`, `${MONTH}_c_food_8000`]);
});

await t("alerts: a race between two writes still fires the 80% alert once", async () => {
  const { fs, call, pushes } = await ready2();
  await call("pfm.budget.set", { categoryId: "_total", limit: "100", alertsBp: [8000] });
  // Hold the first alert write until a second request has also decided to fire the same alert, then let both go.
  const real = fs.fsCommit.bind(fs); let waiting = null, attempts = 0, blocked = 0;
  fs.fsCommit = async (tk, w) => {
    const isAlert = w.length === 1 && /\/alerts\//.test(w[0].update?.name || "");
    if (isAlert) {
      attempts++;
      if (!waiting) { let go; waiting = new Promise((r) => (go = r)); waiting.go = go; await waiting; }
      else waiting.go();
    }
    try { return await real(tk, w); } catch (e) { if (isAlert) blocked++; throw e; }
  };
  const first = spend(call, "85");                                  // crosses 80 %: its alert write is held
  while (attempts < 1) await new Promise((r) => setTimeout(r, 1));
  await Promise.all([first, spend(call, "1")]);                     // also sees >= 80 % and tries the same alert
  fs.fsCommit = real;
  assert.equal(attempts >= 2, true); assert.equal(blocked >= 1, true);   // a duplicate really was attempted, and refused
  const fired = [...fs.docs.keys()].filter((n) => n.includes(`/alerts/${MONTH}__total_8000`));
  assert.equal(fired.length, 1);
  // one push for this budget whichever alert is most serious (after day ~8 of the month that is the pace alert)
  assert.equal(pushes.filter((p) => /كلّ المصروفات/.test(p.title)).length, 1);
});

await t("budget.list: spent, remaining, state, pace; alerts list and read", async () => {
  const { call } = await ready2();
  await call("pfm.budget.set", { categoryId: "c_rent", limit: "1000" });
  await call("pfm.budget.set", { categoryId: "_total", limit: "2000" });
  await assert.rejects(call("pfm.budget.set", { categoryId: "c_salary", limit: "10" }), err("bad_category"));
  await assert.rejects(call("pfm.budget.set", { categoryId: "c_rent", limit: "0" }), err("bad_amount"));
  await spend(call, "900", "c_rent"); await spend(call, "50", "c_food");
  const r = await call("pfm.budget.list", {});
  assert.deepEqual(r.budgets.map((b) => b.categoryId), ["_total", "c_rent"]);
  const rent = r.budgets[1];
  assert.equal(rent.spent, 90000); assert.equal(rent.remaining, 10000); assert.equal(rent.state, "warn"); assert.equal(r.budgets[0].spent, 95000);
  const al = await call("pfm.alerts.list", {});
  assert.ok(al.alerts.length >= 2);
  await call("pfm.alerts.read", { ids: al.alerts.map((a) => a.id) });
  assert.equal((await call("pfm.get")).alerts.length, 0);
  await call("pfm.budget.delete", { categoryId: "c_rent" });
  assert.equal((await call("pfm.budget.list", {})).budgets.length, 1);
});

await t("rules: pick the category, sealed at rest, same text replaces", async () => {
  const { fs, call } = await ready2();
  const r = await call("pfm.rule.upsert", { contains: "Uber", categoryId: "c_transport", kind: "expense" });
  assert.ok(![...fs.docs.values()].some((e) => JSON.stringify(e.data).includes("Uber")));   // rule text encrypted
  const a = await call("pfm.tx.add", { idemKey: k(), kind: "expense", amount: "12", counterparty: "UBER *trip", date: TODAY });
  assert.equal(a.tx.categoryId, "c_transport"); assert.equal(a.tx.autoCategorized, true);
  await assert.rejects(call("pfm.tx.add", { idemKey: k(), kind: "expense", amount: "12", counterparty: "Nobody", date: TODAY }), err("bad_category"));
  await call("pfm.rule.upsert", { contains: "uber", categoryId: "c_food", kind: "expense" });
  const g = await call("pfm.get");
  assert.equal(g.rules.length, 1); assert.equal(g.rules[0].categoryId, "c_food"); assert.equal(g.rules[0].contains, "uber");
  await assert.rejects(call("pfm.rule.upsert", { contains: "x", categoryId: "c_food" }), err("bad_contains"));
  await call("pfm.rule.delete", { id: r.rule.id });
  assert.equal((await call("pfm.get")).rules.length, 0);
});

await t("recurring: past start catches up as suggestions, outside totals until confirmed; no duplicates", async () => {
  const { fs, call } = await ready2();
  const start = addDays(TODAY, -70);
  const day = Number(start.slice(8, 10));
  const r = await call("pfm.recurring.upsert", { kind: "expense", amount: "900", categoryId: "c_rent", counterparty: "Landlord", rule: { freq: "monthly", day }, startDate: start });
  const rows = [...fs.docs].filter(([n]) => n.includes("/tx/r_")).map(([, e]) => e.data);
  assert.ok(rows.length >= 2 && rows.length <= 4); assert.ok(rows.every((t) => t.status === "suggested" && t.source === "recurring"));
  assert.equal(month(fs, "u1", C.budgetMonth(rows.at(-1).date)).expense || 0, 0);   // not in totals
  const g = await call("pfm.get");
  assert.equal(g.suggestedCount, rows.length); assert.equal(g.recurring[0].counterparty, "Landlord");
  await call("pfm.get");                                                                       // repeat: nothing new
  assert.equal([...fs.docs.keys()].filter((n) => n.includes("/tx/r_")).length, rows.length);
  // confirm the latest (with a corrected amount), skip the rest
  const list = (await call("pfm.tx.list", { month: C.budgetMonth(rows.at(-1).date) })).items.filter((t) => t.status === "suggested");
  const c = await call("pfm.tx.confirm", { id: list[0].id, rev: list[0].rev, amount: "950" });
  assert.equal(c.tx.status, "booked"); assert.equal(c.tx.amount, 95000);
  assert.equal(month(fs, "u1", list[0].month).expense, 95000);
  await assert.rejects(call("pfm.tx.confirm", { id: list[0].id, rev: 2 }), err("not_suggested"));
  for (const id of [...fs.docs.keys()].filter((n) => n.includes("/tx/r_")).map((n) => n.split("/").pop()).filter((id) => id !== list[0].id)) {
    const t0 = fs.docs.get(`${ROOT}/pfm/u1/tx/${id}`).data; await call("pfm.tx.delete", { id, rev: t0.rev });
  }
  assert.equal((await call("pfm.get")).suggestedCount, 0);
  const due = fs.docs.get(`${ROOT}/pfmDue/u1`).data;
  assert.equal(due.next, r.recurring.id && (await call("pfm.get")).recurring[0].nextDate); assert.ok(due.next > TODAY);
});

await t("recurring: auto mode books at once, 'after' skips today, pause/resume skips missed, delete clears the index", async () => {
  const { fs, call } = await ready2();
  const day = Number(TODAY.slice(8, 10));
  const auto = await call("pfm.recurring.upsert", { kind: "income", amount: "5000", categoryId: "c_salary", rule: { freq: "monthly", day }, startDate: TODAY, mode: "auto" });
  assert.equal(month(fs, "u1", MONTH).income, 500000);                    // booked, in totals
  const sub = await call("pfm.recurring.upsert", { kind: "expense", amount: "15", categoryId: "c_telecom", rule: { freq: "monthly", day }, startDate: TODAY, after: true });
  assert.ok(sub.recurring.nextDate > TODAY);                               // today's entry was added by hand
  assert.equal([...fs.docs.keys()].filter((n) => n.includes(`/tx/r_${sub.recurring.id}`)).length, 0);
  await call("pfm.recurring.pause", { id: sub.recurring.id });
  const recDoc = fs.docs.get(`${ROOT}/pfm/u1/recurring/${sub.recurring.id}`); recDoc.data.nextDate = addDays(TODAY, -100);   // long pause
  await call("pfm.recurring.pause", { id: sub.recurring.id, paused: false });
  assert.ok(fs.docs.get(`${ROOT}/pfm/u1/recurring/${sub.recurring.id}`).data.nextDate >= TODAY);   // missed months skipped
  await assert.rejects(call("pfm.recurring.upsert", { kind: "expense", amount: "1", categoryId: "c_food", rule: { freq: "daily" } }), err("bad_rule"));
  await call("pfm.recurring.delete", { id: auto.recurring.id }); await call("pfm.recurring.delete", { id: sub.recurring.id });
  assert.equal(fs.docs.has(`${ROOT}/pfmDue/u1`), false);
});

await t("cron: finds due users, creates suggestions, sends one reminder, is idempotent", async () => {
  const { fs, d, env, call, pushes } = await ready2();
  const r = await call("pfm.recurring.upsert", { kind: "expense", amount: "40", categoryId: "c_utilities", rule: { freq: "weekly", weekday: 1 }, startDate: addDays(TODAY, 1) });
  assert.equal([...fs.docs.keys()].filter((n) => n.includes("/tx/r_")).length, 0);
  // time passes: the next date is now in the past
  const past = addDays(TODAY, -1);
  fs.docs.get(`${ROOT}/pfm/u1/recurring/${r.recurring.id}`).data.nextDate = past; fs.docs.get(`${ROOT}/pfmDue/u1`).data.next = past;
  const out = await pfmCron(env, d, 10);
  assert.deepEqual(out, { users: 1, rows: 1 });
  assert.equal(pushes.length, 1); assert.match(pushes[0].body, /مستحقّة/);
  assert.equal((await pfmCron(env, d, 10)).rows, 0);                       // next date moved on: nothing due
  assert.equal(pushes.length, 1);
  assert.deepEqual(await pfmCron({}, d, 10), { users: 0 });                // not configured: does nothing
});

await t("purge also removes P2 data", async () => {
  const { fs, d, call } = await ready2();
  await call("pfm.budget.set", { categoryId: "c_food", limit: "10" }); await spend(call, "9");
  await call("pfm.rule.upsert", { contains: "shop", categoryId: "c_food" });
  await call("pfm.recurring.upsert", { kind: "expense", amount: "1", categoryId: "c_food", rule: { freq: "monthly", day: 1 }, startDate: addDays(TODAY, 40) });
  const purgeColl = async (_t, rel, spendOk) => { for (const x of await fs.fsList(null, rel)) { if (!spendOk()) return false; await fs.fsCommit(null, [{ delete: x.name }]); } return true; };
  assert.equal(await purgePfm(d, "tok", "u1", () => true, purgeColl), true);
  assert.deepEqual([...fs.docs.keys()].filter((n) => n.includes("u1")), []);
});

// ========================= P3: invoices =========================
const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 1)]).toString("base64");
async function shop(opts = {}) {
  const r = await ready2(opts);
  await r.call("pfm.biz.set", { name: "Khalid Design", contact: "+966 51 234 5678", address: "Riyadh, King Fahd Rd", taxId: "300123456700003", invoicePrefix: "INV" });
  const acct = await r.call("pfm.account.upsert", { type: "bank", currency: "GBP", label: "Main", holderName: "Khalid", bankName: "Deutsche Bank", number: "DE89 3704 0044 0532 0130 00" });
  r.acct = acct.account;
  return r;
}
const draft = (call, extra = {}) => call("inv.create", { client: { name: "Nile Trading", contact: "billing@nile.example" }, currency: "GBP",
  items: [{ description: "Design work", qty: "2", unitPrice: "450.00" }, { description: "Hosting", qty: "1", unitPrice: "30" }], issueDate: TODAY, ...extra });

await t("business settings: sealed at rest, tax rates and prefix validated, next number preview", async () => {
  const { fs, call } = await shop();
  const b = await call("pfm.biz.get");
  assert.equal(b.biz.address, "Riyadh, King Fahd Rd"); assert.equal(b.biz.taxRegistered, false);
  assert.equal(b.nextNumber, `INV-${TODAY.slice(0, 4)}-0001`);
  assert.ok(!JSON.stringify(fs.docs.get(`${ROOT}/pfm/u1`).data).includes("King Fahd"));
  await assert.rejects(call("pfm.biz.set", { invoicePrefix: "inv/2" }), err("bad_prefix"));
  await assert.rejects(call("pfm.biz.set", { taxRates: [{ label: "VAT", rate: "120" }] }), err("bad_rate"));
  const r = await call("pfm.biz.set", { taxRegistered: true, taxLabel: "VAT", taxRates: [{ id: "std", label: "Standard", rate: "19" }], defaultTaxRateId: "std" });
  assert.equal(r.biz.taxRates[0].rate, "19"); assert.equal(r.biz.defaultTaxRateId, "std");
});

await t("C288: phone, address and Sawa ID for both parties reach the invoice; old snapshots take today's phone and code", async () => {
  const { fs, call } = await shop();
  await assert.rejects(call("pfm.biz.set", { sawaId: "12345" }), err("bad_sawa_id"));
  const b = await call("pfm.biz.set", { phone: "+249 912 345 678", sawaId: "136-860-8541" });
  assert.equal(b.biz.phone, "+249 912 345 678"); assert.equal(b.biz.sawaId, "1368608541");
  assert.ok(!JSON.stringify(fs.docs.get(`${ROOT}/pfm/u1`).data).includes("912 345"));
  await assert.rejects(draft(call, { client: { name: "Nile", sawaId: "abc" } }), err("bad_sawa_id"));
  const d = await draft(call, { client: { name: "Nile Trading", phone: "+249 911 111 111", address: "Bahri, Khartoum North", sawaId: "2223334445" } });
  assert.equal(d.invoice.client.address, "Bahri, Khartoum North"); assert.equal(d.invoice.client.sawaId, "2223334445");
  const inv = (await call("inv.send", { id: d.invoice.id })).invoice;
  const html = (await call("inv.html", { id: inv.id, lang: "en" })).html;
  for (const s of ["+249 912 345 678", "136-860-8541", "Riyadh, King Fahd Rd", "+249 911 111 111", "Bahri, Khartoum North", "222-333-4445", "Sawa ID"]) assert.ok(html.includes(s), s);
  // an invoice sent before C288 has no phone or Sawa ID in its issuer snapshot: today's details fill them
  const iss = fs.docs.get(`${ROOT}/invoices/${inv.id}`).data.issuer;
  assert.ok(iss.sawaId === "1368608541" && iss.phone && !String(iss.phone).includes("912"));   // the phone is sealed in the snapshot
  delete iss.phone; delete iss.sawaId;
  const old = (await call("inv.html", { id: inv.id, lang: "en" })).html;
  assert.ok(old.includes("+249 912 345 678") && old.includes("136-860-8541"));
});

await t("receiving accounts: masked, sealed, number change pushes a warning, wallet type refused", async () => {
  const { fs, call, pushes, acct } = await shop();
  assert.equal(acct.number, "•••• 3000");
  assert.ok(![...fs.docs.values()].some((e) => JSON.stringify(e.data).includes("370400440532013000")));
  await assert.rejects(call("pfm.account.upsert", { type: "bank", label: "X", holderName: "K", bankName: "B", number: "DE00370400440532013000" }), err("bad_account"));
  await assert.rejects(call("pfm.account.upsert", { type: "sawa_wallet" }), err("bad_account"));
  const before = pushes.length;
  await call("pfm.account.upsert", { id: acct.id, type: "bank", currency: "GBP", label: "Main", holderName: "Khalid", bankName: "Deutsche Bank", number: "GB82WEST12345698765432" });
  assert.equal(pushes.length, before + 1); assert.match(pushes.at(-1).body, /5432/);
  await call("pfm.account.archive", { id: acct.id });
  assert.equal((await call("pfm.biz.get")).accounts[0].archived, true);
});

await t("logo: real bytes only, size capped", async () => {
  const { call } = await shop();
  assert.equal((await call("pfm.logo.set", { data: PNG })).size, 64);
  assert.equal((await call("pfm.biz.get")).logo, PNG);
  await assert.rejects(call("pfm.logo.set", { data: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }), err("bad_logo"));
  await assert.rejects(call("pfm.logo.set", { data: "data:image/jpeg;base64," + PNG.split(",")[1] }), err("bad_logo"));   // says JPEG, is PNG
  await assert.rejects(call("pfm.logo.set", { data: "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200 * 1024)]).toString("base64") }), err("bad_logo"));
});

await t("drafts: totals on the server, tax only when registered, client sealed, edit with rev, delete", async () => {
  const { fs, call } = await shop();
  await assert.rejects(draft(call, { items: [{ description: "X", qty: "1", unitPrice: "10", taxRate: "19" }] }), err("tax_not_registered"));
  const d1 = await draft(call);
  assert.equal(d1.invoice.status, "draft"); assert.equal(d1.invoice.number, null); assert.equal(d1.invoice.totals.total, 93000);
  assert.equal(d1.invoice.client.name, "Nile Trading");
  assert.ok(!JSON.stringify(fs.docs.get(`${ROOT}/invoices/${d1.invoice.id}`).data).includes("Nile Trading"));
  assert.equal((await call("inv.preview", { currency: "GBP", items: [{ description: "a", qty: "3", unitPrice: "1.10" }] })).totals.total, 330);
  await call("pfm.biz.set", { taxRegistered: true, taxLabel: "VAT", taxRates: [{ id: "std", label: "Standard", rate: "19" }] });
  const u = await call("inv.update", { id: d1.invoice.id, rev: 1, items: [{ description: "Design work", qty: "2", unitPrice: "450", taxRateId: "std", discount: { type: "amt", amount: "50" } }],
    invoiceDiscount: { type: "pct", rate: "10" } });
  // 900 − 50 = 850; −10 % = 765; VAT 19 % = 145.35; total 910.35
  assert.equal(u.invoice.totals.total, 91035); assert.equal(u.invoice.totals.taxBreakdown[0].taxRate, "19"); assert.equal(u.invoice.taxLabel, "VAT");
  const u2 = await call("inv.update", { id: d1.invoice.id, rev: 2, notes: "Thanks" });      // items untouched: stored discounts survive
  assert.equal(u2.invoice.totals.total, 91035); assert.equal(u2.invoice.notes, "Thanks");
  await assert.rejects(call("inv.update", { id: d1.invoice.id, rev: 1, notes: "x" }), err("stale"));
  await call("inv.delete", { id: d1.invoice.id });
  assert.equal(fs.docs.has(`${ROOT}/invoices/${d1.invoice.id}`), false);
  await assert.rejects(call("inv.get", { id: d1.invoice.id }), err("not_found"));
});

await t("send: yearly numbers, unique even when sent together, snapshot, frozen afterwards", async () => {
  const { fs, call, acct } = await shop();
  const [a, b, c] = await Promise.all([draft(call, { payoutAccountIds: [acct.id] }), draft(call), draft(call)]);
  const sent = await Promise.all([a, b, c].map((d0) => call("inv.send", { id: d0.invoice.id })));
  const nums = sent.map((r) => r.invoice.number).sort();
  const Y = TODAY.slice(0, 4);
  assert.deepEqual(nums, [`INV-${Y}-0001`, `INV-${Y}-0002`, `INV-${Y}-0003`]);
  const ra = sent.find((r) => r.invoice.id === a.invoice.id).invoice;
  assert.equal(ra.issuer.taxId, "300123456700003"); assert.equal(ra.payoutAccounts[0].number, "DE89370400440532013000");
  assert.equal(fs.docs.get(`${ROOT}/payLinks/${ra.payLinkToken}`).data.invoiceId, a.invoice.id);
  await assert.rejects(call("inv.update", { id: a.invoice.id, rev: ra.rev, notes: "x" }), err("not_draft"));
  await assert.rejects(call("inv.send", { id: a.invoice.id }), err("not_draft"));
  // a new year starts again at 0001
  const next = await draft(call, { issueDate: `${Number(Y) + 1}-01-02`, dueDate: `${Number(Y) + 1}-01-20` });
  assert.equal((await call("inv.send", { id: next.invoice.id })).invoice.number, `INV-${Number(Y) + 1}-0001`);
  // and the business name is required before sending
  const r2 = await ready2(); const d2 = await draft(r2.call);
  await assert.rejects(r2.call("inv.send", { id: d2.invoice.id }), err("business_name_missing"));
});

await t("payments: partial then full, booked as income, idempotent, overpay refused, cancel rules", async () => {
  const { fs, call } = await shop();
  const d0 = await draft(call);
  await assert.rejects(call("inv.markPaid", { id: d0.invoice.id, amount: "1", method: "cash", idemKey: k() }), err("not_payable"));
  const inv = (await call("inv.send", { id: d0.invoice.id })).invoice;
  const key = k();
  const p1 = await call("inv.markPaid", { id: inv.id, amount: "300", method: "bank_transfer", reference: "TRX-77", idemKey: key, paidAt: TODAY });
  assert.equal(p1.invoice.status, "sent"); assert.equal(p1.invoice.amountPaid, 30000); assert.equal(p1.invoice.payments.length, 1);
  await call("inv.markPaid", { id: inv.id, amount: "300", method: "bank_transfer", idemKey: key });            // double tap
  assert.equal((await call("inv.get", { id: inv.id })).invoice.amountPaid, 30000);
  await assert.rejects(call("inv.markPaid", { id: inv.id, amount: "700", method: "cash", idemKey: k() }), err("overpay"));
  await assert.rejects(call("inv.cancel", { id: inv.id }), err("has_payments"));
  const p2 = await call("inv.markPaid", { id: inv.id, amount: "630", method: "cash", idemKey: k() });
  assert.equal(p2.invoice.status, "paid"); assert.equal(p2.invoice.totals.amountDue, 0);
  assert.equal(month(fs, "u1", MONTH).income, 93000); assert.equal(month(fs, "u1", MONTH).cat.c_invoices.i, 93000);
  const rows = (await call("pfm.tx.list", { month: MONTH })).items.filter((t) => t.invoiceId === inv.id);
  assert.equal(rows.length, 2); assert.equal(rows[0].counterparty, "Nile Trading"); assert.equal(rows[0].note, inv.number);
  // a sent invoice without payments can be cancelled; its pay link is revoked
  const d3 = await draft(call); const s3 = (await call("inv.send", { id: d3.invoice.id })).invoice;
  assert.equal((await call("inv.cancel", { id: s3.id, reason: "duplicate" })).invoice.status, "cancelled");
  assert.equal(fs.docs.get(`${ROOT}/payLinks/${s3.payLinkToken}`).data.revoked, true);
  await assert.rejects(call("inv.markPaid", { id: s3.id, amount: "1", method: "cash", idemKey: k() }), err("not_payable"));
});

await t("foreign-currency invoice: payment booked with the typed rate, or waiting for one", async () => {
  const { fs, call } = await shop();
  const inv = (await call("inv.send", { id: (await draft(call, { currency: "USD" })).invoice.id })).invoice;
  await call("inv.markPaid", { id: inv.id, amount: "100", method: "cash", idemKey: k(), fxRate: "0.92" });
  await call("inv.markPaid", { id: inv.id, amount: "100", method: "cash", idemKey: k() });
  const m = month(fs, "u1", MONTH);
  assert.equal(m.income, 9200); assert.equal(m.ratePending, 1);
});

await t("printable page: number, logo, accounts, escaped client text; list and outstanding", async () => {
  const { call, acct } = await shop();
  await call("pfm.logo.set", { data: PNG });
  const inv = (await call("inv.send", { id: (await draft(call, { client: { name: "<b>Nile</b> & Co" }, payoutAccountIds: [acct.id] })).invoice.id })).invoice;
  const h = await call("inv.html", { id: inv.id, lang: "en" });
  assert.match(h.html, new RegExp(inv.number)); assert.ok(h.html.includes(PNG)); assert.ok(h.html.includes("DE89370400440532013000"));
  assert.ok(h.html.includes("&lt;b&gt;Nile&lt;/b&gt; &amp; Co") && !h.html.includes("<b>Nile"));
  const dft = await draft(call);
  assert.match((await call("inv.html", { id: dft.invoice.id, lang: "ar" })).html, /مسوّدة/);
  const l = await call("inv.list", {});
  assert.equal(l.items.length, 2); assert.deepEqual(l.outstanding, [{ currency: "GBP", amount: 93000 }]);
  assert.equal((await call("inv.list", { status: "draft" })).items.length, 1);
  assert.equal(l.items.find((i) => i.id === inv.id).clientName, "<b>Nile</b> & Co");
});

await t("invoices are private to their issuer", async () => {
  const { call } = await shop();
  const d0 = await draft(call);
  await call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" }, "u2");
  await assert.rejects(call("inv.get", { id: d0.invoice.id }, "u2"), err("not_found"));
  await assert.rejects(call("inv.send", { id: d0.invoice.id }, "u2"), err("not_found"));
  assert.equal((await call("inv.list", {}, "u2")).items.length, 0);
});

await t("overdue: the cron flips sent invoices past due once and tells the issuer", async () => {
  const { fs, d, env, call, pushes } = await shop();
  const inv = (await call("inv.send", { id: (await draft(call)).invoice.id })).invoice;
  const notYet = await pfmCron(env, d, 10);
  assert.equal(notYet.overdue, undefined);
  fs.docs.get(`${ROOT}/invoices/${inv.id}`).data.dueDate = addDays(TODAY, -1);
  const before = pushes.length;
  assert.equal((await pfmCron(env, d, 10)).overdue, 1);
  assert.equal((await call("inv.get", { id: inv.id })).invoice.status, "overdue");
  assert.equal(pushes.length, before + 1); assert.match(pushes.at(-1).title, new RegExp(inv.number));
  assert.equal((await pfmCron(env, d, 10)).overdue, undefined);
  assert.equal((await call("inv.markPaid", { id: inv.id, amount: "930", method: "cash", idemKey: k() })).invoice.status, "paid");   // overdue can still be paid
});

await t("account deletion removes invoices, payments and pay links", async () => {
  const { fs, d, call } = await shop();
  const inv = (await call("inv.send", { id: (await draft(call)).invoice.id })).invoice;
  await call("inv.markPaid", { id: inv.id, amount: "10", method: "cash", idemKey: k() });
  const purgeColl = async (_t, rel, ok) => { for (const x of await fs.fsList(null, rel)) { if (!ok()) return false; await fs.fsCommit(null, [{ delete: x.name }]); } return true; };
  assert.equal(await purgePfm(d, "tok", "u1", () => true, purgeColl), true);
  assert.deepEqual([...fs.docs.keys()].filter((n) => n.includes("u1") || n.includes("/invoices/") || n.includes("/payLinks/")), []);
});

// ========================= P4: public pay page and claims =========================
import { handlePfmPublic } from "./pfm-worker.mjs";
let ipSeq = 0;
const pub = (r, op, payload, ip) => handlePfmPublic(op, payload, r.env, r.d, ip || "10.0.0." + (++ipSeq));
async function sentInvoice(extra = {}) {
  const r = await shop();
  await r.call("pfm.account.upsert", { id: r.acct.id, type: "bank", currency: "GBP", label: "Main", holderName: "Khalid", bankName: "Deutsche Bank", number: "DE89370400440532013000" });
  const inv = (await r.call("inv.send", { id: (await draft(r.call, { payoutAccountIds: [r.acct.id], ...extra })).invoice.id })).invoice;
  r.inv = inv; r.tok = inv.payLinkToken; return r;
}
const claim = (r, extra = {}) => pub(r, "pay.claim", { token: r.tok, amount: "930", payoutAccountId: r.acct.id, reference: "TRX-1", payer: { name: "Sara", phone: "+20 100" }, idemKey: k(), ...extra });

await t("pay.view: the link shows the invoice; bad, draft-less and cancelled links behave", async () => {
  const r = await sentInvoice();
  const v = await pub(r, "pay.view", { token: r.tok });
  assert.equal(v.number, r.inv.number); assert.equal(v.amountDue, 93000); assert.equal(v.payable, true); assert.deepEqual(v.methods, ["transfer"]);
  assert.equal(v.accounts[0].number, "DE89370400440532013000"); assert.equal(v.issuer.name, "Khalid Design"); assert.match(v.html, new RegExp(r.inv.number));
  assert.equal(v.client.name, "Nile Trading");
  await assert.rejects(pub(r, "pay.view", { token: "x".repeat(22) }), err("not_found"));
  await assert.rejects(pub(r, "pay.view", { token: "../../pfm/u1" }), err("not_found"));
  await assert.rejects(pub(r, "pay.other", { token: r.tok }), /unknown op/);
  await assert.rejects(handlePfmPublic("pay.view", { token: r.tok }, {}, r.d, "1.1.1.1"), /pfm_not_configured/);
  await r.call("inv.cancel", { id: r.inv.id });
  const c = await pub(r, "pay.view", { token: r.tok });
  assert.equal(c.status, "cancelled"); assert.equal(c.payable, false); assert.deepEqual(c.methods, []);
  assert.equal((await r.call("inv.link", { id: r.inv.id })).url, "https://www.sawaaap.com/pay/" + r.tok);
});

await t("pay.claim: validated, idempotent, limited, sealed, and the issuer is told", async () => {
  const r = await sentInvoice();
  await assert.rejects(claim(r, { payer: { name: "" } }), err("bad_payer"));
  await assert.rejects(claim(r, { payoutAccountId: "pa_nope" }), err("bad_account"));
  await assert.rejects(claim(r, { amount: "931" }), err("overpay"));
  const before = r.pushes.length;
  const key = k();
  const c1 = await claim(r, { amount: "300", idemKey: key });
  assert.equal(c1.state, "claimed");
  assert.deepEqual(await claim(r, { amount: "300", idemKey: key }), c1);                 // same request again: nothing new
  assert.equal(r.pushes.length, before + 1); assert.match(r.pushes.at(-1).title, /Sara/);
  const g = (await r.call("inv.get", { id: r.inv.id })).invoice;
  assert.equal(g.status, "sent"); assert.equal(g.amountPaid, 0);                           // a claim changes nothing yet
  assert.equal(g.payments[0].payer.name, "Sara"); assert.equal(g.payments[0].reference, "TRX-1");
  assert.ok(![...r.fs.docs.values()].some((e) => JSON.stringify(e.data).includes("TRX-1")));
  await assert.rejects(claim(r, { amount: "631" }), err("overpay"));                           // 930 − 300 still claimed = 630 room
  for (let i = 0; i < 4; i++) await claim(r, { amount: "1" });
  await assert.rejects(claim(r, { amount: "1" }), err("claim_pending"));                       // 5 open claims max
  assert.equal((await r.call("inv.list", {})).claims, 5);
});

await t("pay.claim: whole amount when partial payment is off; two full claims at once → one", async () => {
  const r = await sentInvoice({ allowPartial: false });
  await assert.rejects(claim(r, { amount: "100" }), err("partial_not_allowed"));
  const res = await Promise.allSettled([claim(r), claim(r)]);
  assert.equal(res.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(res.find((x) => x.status === "rejected").reason.message, /^overpay|^partial_not_allowed/);
});

await t("pay.claim: proof screenshot checked and kept apart", async () => {
  const r = await sentInvoice();
  await assert.rejects(claim(r, { proof: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }), err("bad_proof"));
  const c = await claim(r, { proof: PNG });
  const g = (await r.call("inv.get", { id: r.inv.id })).invoice;
  assert.equal(g.payments[0].hasProof, true); assert.equal(g.payments[0].proof, undefined);
  assert.equal((await r.call("inv.claim.proof", { id: r.inv.id, payId: c.payId })).data, PNG);
});

await t("decide: confirm books the payment (amount can be corrected), reject frees the room", async () => {
  const r = await sentInvoice();
  const a = await claim(r, { amount: "500" }), b = await claim(r, { amount: "430" });
  const c1 = await r.call("inv.claim.decide", { id: r.inv.id, payId: a.payId, decision: "confirm", amount: "480" });
  assert.equal(c1.invoice.amountPaid, 48000); assert.equal(c1.invoice.status, "sent");
  assert.equal(month(r.fs, "u1", MONTH).income, 48000);
  const row = (await r.call("pfm.tx.list", { month: MONTH })).items.find((t) => t.invoiceId === r.inv.id);
  assert.equal(row.counterparty, "Sara");
  await assert.rejects(r.call("inv.claim.decide", { id: r.inv.id, payId: a.payId, decision: "confirm" }), err("not_found"));
  await r.call("inv.claim.decide", { id: r.inv.id, payId: b.payId, decision: "reject", note: "not received" });
  const doc = r.fs.docs.get(`${ROOT}/invoices/${r.inv.id}`).data;
  assert.equal(doc.openClaims, 0); assert.equal(doc.claimedAmount, 0);
  assert.equal((await pub(r, "pay.view", { token: r.tok })).amountDue, 45000);
  const fin = await claim(r, { amount: "450" });
  assert.equal((await r.call("inv.claim.decide", { id: r.inv.id, payId: fin.payId, decision: "confirm" })).invoice.status, "paid");
  await assert.rejects(claim(r, { amount: "1" }), err("not_payable"));
  await assert.rejects(r.call("inv.claim.decide", { id: r.inv.id, payId: fin.payId, decision: "maybe" }), err("bad_decision"));
});

await t("public endpoint: per-IP limits", async () => {
  const r = await sentInvoice();
  for (let i = 0; i < 60; i++) await pub(r, "pay.view", { token: r.tok }, "9.9.9.9");
  await assert.rejects(pub(r, "pay.view", { token: r.tok }, "9.9.9.9"), err("rate_limited"));
  for (let i = 0; i < 5; i++) await claim(r, { amount: "1" }).catch(() => 0);
  const ip = "8.8.8.8";
  for (let i = 0; i < 5; i++) await pub(r, "pay.claim", { token: r.tok, idemKey: k() }, ip).catch(() => 0);
  await assert.rejects(pub(r, "pay.claim", { token: r.tok, idemKey: k() }, ip), err("rate_limited"));
});

// ---------- P5: receipt photos and CSV export ----------

const jpeg = (n = 64) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const dataUri = (bytes, type = "image/jpeg") => `data:${type};base64,` + Buffer.from(bytes).toString("base64");

await t("receipts: sealed at rest, kept through edits, removed with the entry", async () => {
  const { fs, call } = await ready();
  const a = await call("pfm.tx.add", { idemKey: "key-rcpt-001", kind: "expense", amount: "40", categoryId: "c_food", date: "2026-11-05" });
  const id = a.tx.id, img = dataUri(jpeg(2048));
  assert.equal(a.tx.hasReceipt, false);
  const r = await call("pfm.tx.receipt.set", { id, data: img });
  assert.equal(r.hasReceipt, true); assert.equal(r.size, 2048);
  const file = fs.docs.get(`${ROOT}/pfm/u1/files/r_${id}`).data;
  assert.match(file.data, /^v1:1:/); assert.ok(!file.data.includes("base64"));            // sealed, not a plain data: URI
  assert.equal((await call("pfm.tx.receipt.get", { id })).data, img);
  let row = (await call("pfm.tx.list", { month: "2026-11" })).items[0];
  assert.equal(row.hasReceipt, true);
  // an edit (full rewrite of the row) keeps the flag
  await call("pfm.tx.update", { id, rev: row.rev, amount: "41" });
  row = (await call("pfm.tx.list", { month: "2026-11" })).items[0];
  assert.equal(row.hasReceipt, true); assert.equal(row.amount, 4100);
  // replace, then remove
  await call("pfm.tx.receipt.set", { id, data: dataUri(jpeg(100)) });
  assert.equal((await call("pfm.tx.receipt.get", { id })).size, 100);
  await call("pfm.tx.receipt.delete", { id });
  assert.equal(fs.docs.get(`${ROOT}/pfm/u1/files/r_${id}`), undefined);
  assert.equal((await call("pfm.tx.receipt.get", { id })).data, null);
  assert.equal((await call("pfm.tx.list", { month: "2026-11" })).items[0].hasReceipt, false);
  // deleting the entry deletes its photo in the same commit
  await call("pfm.tx.receipt.set", { id, data: img });
  row = (await call("pfm.tx.list", { month: "2026-11" })).items[0];
  await call("pfm.tx.delete", { id, rev: row.rev });
  assert.equal(fs.docs.get(`${ROOT}/pfm/u1/files/r_${id}`), undefined);
  await assert.rejects(call("pfm.tx.receipt.set", { id, data: img }), err("not_found"));
  const actions = [...fs.docs].filter(([n]) => n.includes("/audit/u1/log/")).map(([, e]) => e.data.action);
  assert.ok(actions.includes("tx.receipt.set") && actions.includes("tx.receipt.delete"));
});

await t("receipts: only real PNG / JPEG / WebP up to 400 KB", async () => {
  const { fs, call } = await ready();
  const { tx } = await call("pfm.tx.add", { idemKey: "key-rcpt-002", kind: "expense", amount: "5", categoryId: "c_food", date: "2026-11-05" });
  await assert.rejects(call("pfm.tx.receipt.set", { id: tx.id, data: dataUri(jpeg(), "image/png") }), err("bad_receipt"));          // declared type lies
  await assert.rejects(call("pfm.tx.receipt.set", { id: tx.id, data: "data:image/svg+xml;base64,PHN2Zz4=" }), err("bad_receipt"));
  await assert.rejects(call("pfm.tx.receipt.set", { id: tx.id, data: dataUri(new Uint8Array(64).fill(1)) }), err("bad_receipt"));     // not an image
  await assert.rejects(call("pfm.tx.receipt.set", { id: tx.id, data: dataUri(jpeg(400 * 1024 + 1)) }), err("bad_receipt"));          // too big
  await call("pfm.tx.receipt.set", { id: tx.id, data: dataUri(jpeg(400 * 1024)) });                                                  // exactly the limit
  assert.ok(fs.docs.get(`${ROOT}/pfm/u1/files/r_${tx.id}`).data.data.length < 1_000_000);                                            // sealed, still under Firestore's 1 MiB
  await assert.rejects(call("pfm.tx.receipt.set", { id: "nope_0000001", data: dataUri(jpeg()) }), err("not_found"));
  await assert.rejects(call("pfm.tx.receipt.get", { id: "../x" }), err("bad_id"));
  // another user can't read it
  assert.equal((await call("pfm.tx.receipt.get", { id: tx.id }, "u2")).data, null);
});

await t("export: booked rows only, ordered, escaped, both languages", async () => {
  const { fs, call } = await ready({ locale: "en" });
  const add = (k, o) => call("pfm.tx.add", { idemKey: "key-exp-" + k, kind: "expense", categoryId: "c_food", ...o });
  await add("0001", { amount: "10", date: "2026-11-03", note: "=SUM(A1:A9)", counterparty: "Café, \"Nile\"" });
  await add("0002", { amount: "1500", currency: "JPY", fxRate: "0.0052", date: "2026-10-20" });
  await add("0003", { amount: "2.500", currency: "KWD", date: "2026-11-01" });                         // no rate yet
  await call("pfm.tx.add", { idemKey: "key-exp-0004", kind: "income", amount: "2000", categoryId: "c_salary", date: "2026-11-01" });
  const gone = await add("0005", { amount: "7", date: "2026-11-02" });
  await call("pfm.tx.delete", { id: gone.tx.id, rev: gone.tx.rev });
  await call("pfm.tx.receipt.set", { id: "t_key-exp-0001", data: dataUri(jpeg()) });
  fs.docs.set(`${ROOT}/pfm/u1/tx/t_suggested01`, { updateTime: "x", data: { kind: "expense", amount: 900, currency: "GBP", baseAmount: 900, fxRate: "1", categoryId: "c_food",
    date: "2026-11-04", month: "2026-11", status: "suggested", deleted: false, rev: 1, createdAt: "2026-11-04T00:00:00Z" } });
  const r = await call("pfm.export", { from: "2026-10", to: "2026-11" });
  assert.equal(r.filename, "sawa-accountant-2026-10_2026-11.csv"); assert.equal(r.rows, 4); assert.equal(r.truncated, false);
  assert.ok(r.csv.startsWith("﻿Date,Type,Category,Amount,Currency,Amount in GBP,Exchange rate,Paid to / from,Note,Receipt\r\n"));
  const lines = r.csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.slice(1).map((l) => l.slice(0, 10)), ["2026-10-20", "2026-11-01", "2026-11-01", "2026-11-03"]);
  assert.equal(lines[1], "2026-10-20,Expense,Food & groceries,1500,JPY,7.80,0.0052,,,");
  assert.ok(lines.some((l) => l.includes(",2.500,KWD,,,")));                                        // rate pending: base amount and rate empty
  assert.ok(lines[4].endsWith(',"Café, ""Nile""",\'=SUM(A1:A9),yes'));                           // quoted, formula defused, receipt marked
  assert.ok(!r.csv.includes("900") && !r.csv.includes(",7.00,"));                                  // suggested and deleted rows left out
  const a = await call("pfm.export", { from: "2026-11", to: "2026-11", lang: "ar" });
  assert.ok(a.csv.startsWith("﻿التاريخ,النوع,الفئة,المبلغ,العملة,المبلغ بـGBP,سعر الصرف,الطرف,ملاحظة,إيصال\r\n"));
  assert.ok(a.csv.includes(",دخل,") && a.csv.includes(",مصروف,") && a.csv.includes(",نعم"));
  await assert.rejects(call("pfm.export", { from: "2024-01", to: "2026-11" }), err("range_too_long"));
  await assert.rejects(call("pfm.export", { from: "2026-12", to: "2026-11" }), err("bad_month"));
  assert.equal((await call("pfm.export", { from: "2025-01", to: "2025-01" })).rows, 0);
});

await t("import: a bank reference makes the row id, so the same transfer is booked once", async () => {
  const { fs, call } = await ready({ baseCurrency: "SDG", tz: "Africa/Khartoum" });
  const p = { ref: { issuer: "bankak", id: "20000000001" }, kind: "expense", amount: "250000.00", categoryId: "c_transport", date: "2026-11-02", note: "5 gallons", counterparty: "Test Supplier" };
  const a = await call("pfm.tx.add", p);
  assert.match(a.tx.id, /^m_[A-Za-z0-9_-]{32}$/);
  assert.equal(a.duplicate, false);
  assert.equal(a.tx.source, "import");
  assert.ok(!a.tx.id.includes("20000000001"), "the id does not reveal the reference");
  const b = await call("pfm.tx.add", { ...p, amount: "1.00" });
  assert.equal(b.duplicate, true);
  assert.equal(b.tx.id, a.tx.id);
  assert.equal(b.tx.amount, 25000000);                                   // the first booking stands
  assert.equal(month(fs, "u1", "2026-11").expense, 25000000);            // counted once
  const other = await call("pfm.tx.add", { ...p, ref: { issuer: "bankak", id: "20000000002" } });
  assert.notEqual(other.tx.id, a.tx.id);
  const elsewhere = await call("pfm.tx.add", p, "u2").catch((e) => e);  // another user, same reference: a different id space
  assert.ok(elsewhere instanceof Error);                                  // (u2 is not initialised: refused, nothing written)
  assert.equal((await call("pfm.tx.add", { ...p, source: "wallet", idemKey: "key-0000009", ref: undefined })).tx.source, "manual");
  await assert.rejects(call("pfm.tx.add", { ...p, ref: { issuer: "Bad Issuer!", id: "20000000003" } }), err("bad_ref"));
  await assert.rejects(call("pfm.tx.add", { ...p, ref: { issuer: "bankak", id: "x" } }), err("bad_ref"));
});

await t("import: ids differ per user for the same reference", async () => {
  const one = await C.importRefId("bankak", "20000000001", "u1", KEK), two = await C.importRefId("bankak", "20000000001", "u2", KEK);
  assert.notEqual(one, two);
  assert.equal(one, await C.importRefId("bankak", "20000000001", "u1", KEK));
});

await t("import prefs: own accounts and confirmed names, sealed at rest, validated, purged", async () => {
  const { fs, d, call } = await ready();
  assert.deepEqual(await call("pfm.import.prefs.get", {}), { accounts: [], names: {} });
  await call("pfm.import.prefs.set", { accounts: ["1111 2222 3333 0001"], names: { "9999888877770001": "Test Supplier" } });
  const got = await call("pfm.import.prefs.get", {});
  assert.deepEqual(got, { accounts: ["1111 2222 3333 0001"], names: { "9999888877770001": "Test Supplier" } });
  const raw = JSON.stringify(fs.docs.get(`${ROOT}/pfm/u1/import/prefs`).data);
  assert.ok(!raw.includes("1111 2222") && !raw.includes("Test Supplier"), "sealed at rest");
  await assert.rejects(call("pfm.import.prefs.set", { accounts: ["not-an-account"] }), err("bad_account"));
  await assert.rejects(call("pfm.import.prefs.set", { accounts: [], names: { "12": "x" } }), err("bad_name"));
  const purgeColl = async (_t, rel, spend) => { for (const x of await fs.fsList(null, rel)) { if (!spend()) return false; await fs.fsCommit(null, [{ delete: x.name }]); } return true; };
  assert.equal(await purgePfm(d, "tok", "u1", () => true, purgeColl), true);
  assert.ok(!fs.docs.has(`${ROOT}/pfm/u1/import/prefs`), "account deletion removes the import prefs");
});

// ---------- C287: pay states, full/partial reports, PDF proofs, links for old invoices, PDF files ----------
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const pdfUri = (b = PDF_BYTES) => "data:application/pdf;base64," + b.toString("base64");

await t("C287 pay state: partial report → partially_paid, the rest → pending_verification, confirm → paid", async () => {
  const r = await sentInvoice();
  assert.equal((await r.call("inv.get", { id: r.inv.id })).invoice.payState, "unpaid");
  const a = await claim(r, { payType: "partial", amount: "300" });
  assert.equal(a.payState, "partially_paid"); assert.equal(a.amount, 30000);
  let g = (await r.call("inv.get", { id: r.inv.id })).invoice;
  assert.equal(g.status, "sent"); assert.equal(g.payState, "partially_paid"); assert.equal(g.claimedAmount, 30000);
  assert.equal((await pub(r, "pay.view", { token: r.tok })).payState, "partially_paid");
  // "full" pays what is still open (630.00), whatever amount was typed
  const b = await claim(r, { payType: "full", amount: "1" });
  assert.equal(b.amount, 63000); assert.equal(b.payState, "pending_verification");
  const list = await r.call("inv.list", {});
  assert.equal(list.items.find((i) => i.id === r.inv.id).payState, "pending_verification");
  const html = (await r.call("inv.html", { id: r.inv.id, lang: "en" })).html;
  assert.match(html, /Paid — pending verification/);
  for (const p of (await r.call("inv.get", { id: r.inv.id })).invoice.payments) await r.call("inv.claim.decide", { id: r.inv.id, payId: p.id, decision: "confirm" });
  g = (await r.call("inv.get", { id: r.inv.id })).invoice;
  assert.equal(g.status, "paid"); assert.equal(g.payState, "paid"); assert.equal(g.claimedAmount, 0);
});

await t("C287 pay type: partial must be below what is open and allowed; unknown type refused", async () => {
  const r = await sentInvoice();
  await assert.rejects(claim(r, { payType: "partial", amount: "930" }), err("partial_is_full"));
  await assert.rejects(claim(r, { payType: "some" }), err("bad_pay_type"));
  const r2 = await sentInvoice({ allowPartial: false });
  await assert.rejects(claim(r2, { payType: "partial", amount: "100" }), err("partial_not_allowed"));
  const f = await claim(r2, { payType: "full" });
  assert.equal(f.amount, 93000); assert.equal(f.payState, "pending_verification");
  await assert.rejects(claim(r2, { payType: "full" }), err("overpay"));                 // nothing left to report
});

await t("C287 proof: a PDF receipt is accepted by its bytes and the issuer gets it back with its type", async () => {
  const r = await sentInvoice();
  await assert.rejects(claim(r, { proof: "data:application/pdf;base64," + Buffer.from("not a pdf at all, really").toString("base64") }), err("bad_proof"));
  await assert.rejects(claim(r, { proof: "data:image/png;base64," + PDF_BYTES.toString("base64") }), err("bad_proof"));   // declared type must match the bytes
  await assert.rejects(claim(r, { proof: pdfUri(Buffer.concat([PDF_BYTES, Buffer.alloc(610 * 1024)])) }), err("bad_proof"));   // over 600 KB
  const c = await claim(r, { payType: "partial", amount: "100", proof: pdfUri(), proofName: "bank-receipt.pdf" });
  const g = (await r.call("inv.get", { id: r.inv.id })).invoice;
  const p = g.payments.find((x) => x.id === c.payId);
  assert.equal(p.hasProof, true); assert.equal(p.proofType, "application/pdf"); assert.equal(p.payType, "partial");
  const got = await r.call("inv.claim.proof", { id: r.inv.id, payId: c.payId });
  assert.equal(got.type, "application/pdf"); assert.equal(got.name, "bank-receipt.pdf"); assert.equal(got.data, pdfUri());
  assert.ok(![...r.fs.docs.values()].some((e) => JSON.stringify(e.data).includes("bank-receipt")), "the file name is sealed");
});

await t("C287 inv.link: an invoice sent without a link gets one on request, and it opens the pay page", async () => {
  const r = await sentInvoice();
  const doc = r.fs.docs.get(`${ROOT}/invoices/${r.inv.id}`);
  r.fs.docs.delete(`${ROOT}/payLinks/${r.tok}`); delete doc.data.payLinkToken;            // as if sent before C267
  const a = await r.call("inv.link", { id: r.inv.id });
  assert.match(a.url, /^https:\/\/www\.sawaaap\.com\/pay\/[a-z0-9]{22}$/);
  assert.equal((await r.call("inv.link", { id: r.inv.id })).url, a.url);                  // stable
  const v = await pub(r, "pay.view", { token: a.token });
  assert.equal(v.number, r.inv.number); assert.equal(v.payable, true);
  const { invoice } = await draft(r.call);
  await assert.rejects(r.call("inv.link", { id: invoice.id }), err("not_sent"));
});

await t("C287 inv.pdf: the phone gets the HTML without Browser Rendering; the file with it; HTML again if it fails", async () => {
  const r = await sentInvoice();
  const a = await r.call("inv.pdf", { id: r.inv.id });
  assert.equal(a.pdf, null); assert.equal(a.via, "device"); assert.match(a.html, new RegExp(r.inv.number)); assert.equal(a.filename, `invoice-${r.inv.number}.pdf`);
  const env = { ...r.env, CF_ACCOUNT_ID: "acct1", CF_BR_TOKEN: "tok1" };
  let sent = null;
  const d = { ...r.d, fetch: async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } }); } };
  const b = await handlePfmOp("inv.pdf", "u1", { id: r.inv.id }, env, d);
  assert.equal(b.via, "server"); assert.equal(Buffer.from(b.pdf, "base64").toString(), PDF_BYTES.toString());
  assert.equal(sent.url, "https://api.cloudflare.com/client/v4/accounts/acct1/browser-rendering/pdf");
  assert.equal(sent.init.headers.Authorization, "Bearer tok1"); assert.match(sent.body.html, new RegExp(r.inv.number));
  assert.deepEqual(sent.body.rejectRequestPattern, ["^(?!data:).*"]);
  const bad = { ...r.d, fetch: async () => new Response(JSON.stringify({ errors: [{ message: "quota" }] }), { status: 429, headers: { "content-type": "application/json" } }) };
  const c = await handlePfmOp("inv.pdf", "u1", { id: r.inv.id }, env, bad);
  assert.equal(c.pdf, null); assert.equal(c.via, "device"); assert.match(c.serverError, /429 quota/); assert.ok(c.html.length > 500);
});

assert.ok(PFM_OPS.includes("pfm.tx.add"));
console.log(process.exitCode ? "FAILED" : `pfm-worker: ${n} passed`);
