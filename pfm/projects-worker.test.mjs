// End-to-end tests of the pfm.proj.* Worker ops against an in-memory Firestore.
// Usage: node pfm/projects-worker.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlePfmOp, purgePfm, PFM_OPS } from "./pfm-worker.mjs";
import * as C from "./pfm-core.mjs";
import { makeFs as makeFsWith, ROOT } from "./fake-firestore.mjs";

const src = readFileSync(new URL("../worker-3.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf("function " + name + "("); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return src.slice(a, i + 1); };
const { toFsValue, fsToJs } = new Function(grab("toFsValue") + grab("fsToJs") + "; return { toFsValue, fsToJs };")();

const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
function setup() {
  const fs = makeFsWith(toFsValue, fsToJs);
  const d = { DOC_ROOT: ROOT, toFsValue, fsToJs, getToken: async () => "tok", ...fs };
  const env = { PFM_KEK_v1: KEK };
  const call = (op, payload, uid = "u1") => handlePfmOp(op, uid, payload, env, d);
  return { fs, d, env, call };
}
const err = (code) => (e) => { assert.match(e.message, new RegExp("^" + code)); return true; };
const rawDocs = (fs, prefix) => [...fs.docs].filter(([k]) => k.startsWith(ROOT + "/" + prefix)).map(([, e]) => e.data);
const auditChain = (fs) => [...fs.docs].filter(([k]) => k.includes("/audit/u1/log/")).sort().map(([, e]) => e.data);

async function ready() {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" });
  return s;
}

const PROJ = { idemKey: "proj-key-0001", name: "House", template: "house_construction", currency: "SDG", targetBudget: "3,000.00", description: "Two-room extension", alertThresholdsPct: [80, 100], lineTolerancePct: 5 };
const LINES = [
  { lineKey: "cement", category: "raw_materials", name: "Cement", unit: "bag", estQty: "100", estUnitPrice: "10", notes: "CEM II" },
  { lineKey: "mason", category: "labor", name: "Mason", unit: "day", estQty: "30", estUnitPrice: "45" },
];

// A project with an approved baseline (cement 1,000.00 + mason 1,350.00 = 2,350.00 against a 3,000.00 budget)
async function withBaseline(s) {
  const { project } = await s.call("pfm.proj.create", { ...PROJ });
  const { estimate } = await s.call("pfm.proj.estimate.create", { pid: project.id, idemKey: "est-key-0001" });
  await s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: estimate.rev, lines: LINES });
  const fresh = (await s.call("pfm.proj.get", { pid: project.id })).estimates[0];
  await s.call("pfm.proj.estimate.approve", { pid: project.id, eid: estimate.id, rev: fresh.rev ?? estimate.rev + 1 });
  return project.id;
}

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

await t("ops are registered and routed under pfm.", async () => {
  for (const op of ["pfm.proj.create", "pfm.proj.estimate.approve", "pfm.proj.tx.add", "pfm.proj.health", "pfm.proj.alerts.ack"])
    assert.ok(PFM_OPS.includes(op), op);
});

await t("create: needs init, validates, is idempotent, seals the description", async () => {
  const s = setup();
  await assert.rejects(s.call("pfm.proj.create", { ...PROJ }), err("pfm_not_initialised"));
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" });
  await assert.rejects(s.call("pfm.proj.create", { ...PROJ, currency: "EUR" }), err("bad_currency"));
  await assert.rejects(s.call("pfm.proj.create", { ...PROJ, idemKey: "short" }), err("bad_idem_key"));
  const a = await s.call("pfm.proj.create", { ...PROJ });
  assert.equal(a.project.targetBudget, 300000);
  assert.equal(a.project.description, "Two-room extension");
  const again = await s.call("pfm.proj.create", { ...PROJ, name: "Changed" });
  assert.equal(again.project.name, "House");                       // retry returns the first row
  const raw = rawDocs(s.fs, `pfm/u1/projects/`).find((d) => d.description);
  assert.ok(raw.description && raw.description !== "Two-room extension");   // stored sealed
  assert.equal(s.fs.docs.get(`${ROOT}/pfm/u1/meta/projects`).data.schemaVersion, 1);  // migration ran
});

await t("update: stale rev refused, currency locked, audited", async () => {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" });
  const { project } = await s.call("pfm.proj.create", { ...PROJ });
  await assert.rejects(s.call("pfm.proj.update", { pid: project.id, rev: 9, name: "X" }), err("stale"));
  await assert.rejects(s.call("pfm.proj.update", { pid: project.id, rev: 1, currency: "USD" }), err("currency_locked"));
  const u = await s.call("pfm.proj.update", { pid: project.id, rev: 1, targetBudget: "3500", name: "House 2" });
  assert.equal(u.project.targetBudget, 350000);
  assert.equal(u.project.rev, 2);
  assert.ok(auditChain(s.fs).some((e) => e.action === "project.update"));
});

await t("status: whitelisted transitions only", async () => {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" });
  const { project } = await s.call("pfm.proj.create", { ...PROJ });
  await assert.rejects(s.call("pfm.proj.status", { pid: project.id, rev: 1, to: "completed" }), err("bad_transition"));
  const r = await s.call("pfm.proj.status", { pid: project.id, rev: 1, to: "active" });
  assert.equal(r.project.status, "active");
  const hold = await s.call("pfm.proj.status", { pid: project.id, rev: r.project.rev, to: "on_hold" });
  assert.equal(hold.project.status, "on_hold");
});

await t("estimate: one open draft, line validation, approval freezes the baseline", async () => {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" });
  const { project } = await s.call("pfm.proj.create", { ...PROJ });
  const { estimate } = await s.call("pfm.proj.estimate.create", { pid: project.id, idemKey: "est-key-0001" });
  assert.equal(estimate.revision, 1);
  await assert.rejects(s.call("pfm.proj.estimate.create", { pid: project.id, idemKey: "est-key-0002" }), err("draft_exists"));
  await assert.rejects(s.call("pfm.proj.estimate.approve", { pid: project.id, eid: estimate.id, rev: estimate.rev }), err("empty_estimate"));
  await assert.rejects(s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: estimate.rev, lines: [{ ...LINES[0], category: "fun" }] }), err("bad_category"));
  await assert.rejects(s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: estimate.rev, lines: [LINES[0], LINES[0]] }), err("dup_line_key"));
  await assert.rejects(s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: 99, lines: LINES }), err("stale"));
  const l = await s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: estimate.rev, lines: LINES });
  assert.deepEqual(l.totals, { total: 235000, byCategory: { raw_materials: 100000, labor: 135000 } });
  assert.equal([...s.fs.docs.keys()].filter((k) => /\/pfm\/u1\/projects\/[^/]+$/.test(k)).length, 1);
  const names = rawDocs(s.fs, `pfm/u1/projects/${project.id}/estimates/${estimate.id}/lines/`).map((d) => d.name);
  assert.ok(names.every((x) => typeof x === "string"));
  const approved = await s.call("pfm.proj.estimate.approve", { pid: project.id, eid: estimate.id, rev: l.estimate.rev });
  assert.equal(approved.estimate.status, "baseline");
  await assert.rejects(s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: approved.estimate.rev, lines: LINES }), err("baseline_locked"));
  const p = (await s.call("pfm.proj.get", { pid: project.id })).project;
  assert.equal(p.status, "active");
  assert.equal(p.baselineEstimateId, estimate.id);
});

await t("change order: a second revision needs a reason and supersedes the baseline on approval", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const base = (await s.call("pfm.proj.get", { pid })).estimates.find((e) => e.status === "baseline");
  await assert.rejects(s.call("pfm.proj.estimate.create", { pid, idemKey: "co-key-00001" }), err("reason_required"));
  const co = await s.call("pfm.proj.estimate.create", { pid, idemKey: "co-key-00001", reason: "Change order 2", fromBaseline: true });
  assert.equal(co.estimate.revision, 2);
  assert.equal(co.estimate.lineCount, 2);
  await s.call("pfm.proj.estimate.approve", { pid, eid: co.estimate.id, rev: co.estimate.rev });
  const all = (await s.call("pfm.proj.get", { pid })).estimates;
  assert.equal(all.find((e) => e.id === base.id).status, "superseded");
  assert.equal(all.find((e) => e.id === co.estimate.id).status, "baseline");
});

await t("ledger: lines must exist on the baseline; ids are idempotent; health follows", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  await assert.rejects(s.call("pfm.proj.tx.add", { pid, idemKey: "tx-key-00001", kind: "expense", amount: "5", lineKey: "nope", occurredOn: "2026-11-02", description: "x" }), err("bad_line"));
  await assert.rejects(s.call("pfm.proj.tx.add", { pid, idemKey: "tx-key-00001", kind: "revenue", amount: "5", lineKey: "cement", occurredOn: "2026-11-02", description: "x" }), err("line_on_non_expense"));
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cap-0001", kind: "capital_injection", amount: "5,000.00", occurredOn: "2026-11-01", description: "Owner money", counterparty: "Mum" });
  const cement = await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cem-0001", kind: "expense", amount: "1,210.00", lineKey: "cement", quantity: "110", unit: "bag", occurredOn: "2026-11-03", description: "Cement delivery" });
  const again = await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cem-0001", kind: "expense", amount: "9.00", lineKey: "cement", occurredOn: "2026-11-03", description: "retry" });
  assert.equal(again.tx.id, cement.tx.id);
  assert.equal(again.tx.amount, 121000);
  assert.equal(cement.tx.description, "Cement delivery");               // decrypted for the owner
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-oth-0001", kind: "expense", amount: "400.00", category: "other", occurredOn: "2026-11-04", description: "Transport" });

  const h = (await s.call("pfm.proj.health", { pid })).health;
  assert.equal(h.actualSpend, 161000);
  assert.equal(h.utilizationBp, 5367);
  assert.equal(h.status, "green");
  assert.equal(h.cashPosition, 500000 - 161000);
  const v = await s.call("pfm.proj.variance", { pid });
  const c = v.lines.find((l) => l.lineKey === "cement");
  assert.equal(c.name, "Cement");
  assert.equal(c.notes, "CEM II");
  assert.equal(c.quantityEffect, 10000);
  assert.equal(c.priceEffect, 11000);
  assert.equal(c.status, "over_budget");
});

await t("alerts: each threshold fires once; a void clears it; acknowledgement is recorded", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  // Baseline is 3,000.00. 2,600.00 spent is 87 %: the 80 % alert fires, the 100 % one does not
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-big-0001", kind: "expense", amount: "2,600.00", category: "other", occurredOn: "2026-11-05", description: "Big" });
  let list = (await s.call("pfm.proj.alerts.list", { pid })).items;
  const keys = list.map((a) => a.id).sort();
  assert.ok(keys.some((k) => k.startsWith("budget:80:")), keys.join(","));
  assert.ok(!keys.some((k) => k.startsWith("budget:100:")));
  // 2,600 + 500 = 3,100 of 3,000 (103 %): the 100 % alert fires once, the 80 % alert is not repeated
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-big-0002", kind: "expense", amount: "500.00", category: "other", occurredOn: "2026-11-05", description: "More" });
  list = (await s.call("pfm.proj.alerts.list", { pid })).items;
  assert.equal(list.filter((a) => a.id.startsWith("budget:80:")).length, 1);
  const b100 = list.find((a) => a.id.startsWith("budget:100:"));
  assert.ok(b100 && b100.severity === "critical");
  const ack = await s.call("pfm.proj.alerts.ack", { pid, key: b100.id });
  assert.ok(ack.alert.acknowledgedAt);
  assert.equal((await s.call("pfm.proj.alerts.list", { pid, unacknowledged: true })).items.length, list.length - 1);

  const big = (await s.call("pfm.proj.tx.list", { pid })).items.find((t) => t.description === "More");
  await s.call("pfm.proj.tx.void", { pid, txId: big.id, reason: "Entered twice" });
  list = (await s.call("pfm.proj.alerts.list", { pid })).items;
  assert.ok(!list.some((a) => a.id.startsWith("budget:100:")), "100% alert cleared after void");
  await assert.rejects(s.call("pfm.proj.tx.void", { pid, txId: "missing-tx-id", reason: "x" }), err("not_found"));
});

await t("concurrent entries on one project: both land, audit chain stays whole", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const real = s.d.fsCommit; let gate = null;
  s.d.fsCommit = async (tk, w) => { if (!gate) { gate = 1; await new Promise((r) => setTimeout(r, 5)); } return real(tk, w); };
  await Promise.all(["tx-race-0001", "tx-race-0002"].map((k) => handlePfmOp("pfm.proj.tx.add", "u1",
    { pid, idemKey: k, kind: "expense", amount: "10", category: "other", occurredOn: "2026-11-06", description: k }, s.env, s.d)));
  const txs = (await s.call("pfm.proj.tx.list", { pid })).items;
  assert.equal(txs.length, 2);
  assert.equal((await C.verifyChain(auditChain(s.fs))).ok, true);
});

await t("purge removes every project row, subcollection and the migration marker", async () => {
  const s = await ready();
  await withBaseline(s);
  const purgeColl = async (_t, rel, spend) => { for (const x of await s.fs.fsList(null, rel)) { if (!spend()) return false; await s.fs.fsCommit(null, [{ delete: x.name }]); } return true; };
  assert.equal(await purgePfm(s.d, "tok", "u1", () => true, purgeColl), true);
  assert.deepEqual([...s.fs.docs.keys()].filter((k) => k.includes("/u1")), []);
});

console.log(process.exitCode ? "FAILED" : `projects-worker: ${n} passed`);
