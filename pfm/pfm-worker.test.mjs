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
  await assert.rejects(call("pfm.init", { baseCurrency: "EUR", tz: "Mars/Base" }), err("bad_tz"));
  const r = await call("pfm.init", { baseCurrency: "EUR", tz: "Europe/Berlin", locale: "en" });
  assert.equal(r.settings.baseCurrency, "EUR");
  assert.equal(r.categories.length, C.DEFAULT_CATEGORIES.length);
  assert.match(r.month, /^\d{4}-\d{2}$/);
  const again = await call("pfm.init", { baseCurrency: "USD", tz: "UTC" });
  assert.equal(again.settings.baseCurrency, "EUR");                       // second init changes nothing
  assert.equal(fs.docs.get(`${ROOT}/audit/u1`).data.headSeq, 1);
});

async function ready(opts = {}) {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "EUR", tz: "Europe/Berlin", ...opts });
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
  await assert.rejects(call("pfm.tx.add", { ...base, currency: "JPY", amount: "1.5" }), err("too_precise"));
});

await t("foreign currency: typed rate, pending rate, last-rate memory", async () => {
  const { fs, call } = await ready();
  const a = await call("pfm.tx.add", { idemKey: "key-usd-0001", kind: "expense", amount: "25.00", currency: "USD", fxRate: "0.9224", categoryId: "c_telecom", date: "2026-11-03" });
  assert.equal(a.tx.baseAmount, 2306); assert.equal(a.tx.fxSource, "manual");
  assert.deepEqual(await call("pfm.fx.last", { from: "USD" }).then((r) => [r.to, r.rate]), ["EUR", "0.9224"]);
  const b = await call("pfm.tx.add", { idemKey: "key-usd-0002", kind: "expense", amount: "10", currency: "USD", categoryId: "c_telecom", date: "2026-11-04" });
  assert.equal(b.tx.baseAmount, null); assert.equal(b.tx.fxSource, "pending");
  let m = month(fs, "u1", "2026-11");
  assert.equal(m.expense, 2306); assert.equal(m.ratePending, 1);
  // adding the rate later moves it from pending into the totals
  await call("pfm.tx.update", { id: b.tx.id, rev: 1, fxRate: "0.92" });
  m = month(fs, "u1", "2026-11");
  assert.equal(m.expense, 2306 + 920); assert.equal(m.ratePending, 0);
  const y = await call("pfm.tx.add", { idemKey: "key-jpy-0001", kind: "expense", amount: "1500", currency: "JPY", fxRate: "0.0061", categoryId: "c_food", date: "2026-11-04" });
  assert.equal(y.tx.amount, 1500); assert.equal(y.tx.baseAmount, 915);           // ¥1,500 × 0.0061 = €9.15
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

assert.ok(PFM_OPS.includes("pfm.tx.add"));
console.log(process.exitCode ? "FAILED" : `pfm-worker: ${n} passed`);
