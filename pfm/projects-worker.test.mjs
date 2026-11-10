// End-to-end tests of the pfm.proj.* Worker ops against an in-memory Firestore.
// Usage: node pfm/projects-worker.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlePfmOp, purgePfm, PFM_OPS } from "./pfm-worker.mjs";
import * as C from "./pfm-core.mjs";
import { makeFs as makeFsWith, ROOT } from "./fake-firestore.mjs";
import { PROJECTS_SCHEMA_VERSION } from "./projects-migrations.mjs";

const src = readFileSync(new URL("../worker-3.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf("function " + name + "("); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return src.slice(a, i + 1); };
const { toFsValue, fsToJs } = new Function(grab("toFsValue") + grab("fsToJs") + "; return { toFsValue, fsToJs };")();

const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
// One store, several users. Each call names its user.
function setup() {
  const fs = makeFsWith(toFsValue, fsToJs);
  const d = { DOC_ROOT: ROOT, toFsValue, fsToJs, getToken: async () => "tok", ...fs };
  const env = { PFM_KEK_v1: KEK };
  const call = (op, payload, uid = "u1") => handlePfmOp(op, uid, payload, env, d);
  return { fs, d, env, call };
}
const err = (code) => (e) => { assert.match(e.message, new RegExp("^" + code)); return true; };
const docsUnder = (fs, rel) => [...fs.docs.keys()].filter((k) => k.startsWith(ROOT + "/" + rel));
const auditChain = (fs, uid = "u1") => [...fs.docs].filter(([k]) => k.includes(`/audit/${uid}/log/`)).sort().map(([, e]) => e.data);

async function ready(uid = "u1") {
  const s = setup();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" }, uid);
  return s;
}

const PROJ = { idemKey: "proj-key-0001", name: "House", template: "house_construction", currency: "SDG", targetBudget: "3,000.00", description: "Two-room extension", alertThresholdsPct: [80, 100], lineTolerancePct: 5 };
const LINES = [
  { lineKey: "cement", category: "raw_materials", name: "Cement", unit: "bag", estQty: "100", estUnitPrice: "10", notes: "CEM II" },
  { lineKey: "mason", category: "labor", name: "Mason", unit: "day", estQty: "30", estUnitPrice: "45" },
];

// A project with an approved baseline: cement 1,000.00 + mason 1,350.00 = 2,350.00 against a 3,000.00 budget
async function withBaseline(s, uid = "u1", extra = {}) {
  const { project } = await s.call("pfm.proj.create", { ...PROJ, ...extra }, uid);
  const { estimate } = await s.call("pfm.proj.estimate.create", { pid: project.id, idemKey: "est-key-0001" }, uid);
  await s.call("pfm.proj.estimate.lines", { pid: project.id, eid: estimate.id, rev: estimate.rev, lines: LINES }, uid);
  await s.call("pfm.proj.estimate.approve", { pid: project.id, eid: estimate.id, rev: estimate.rev + 1 }, uid);
  return project.id;
}
// Invites a second user with the given role and returns them joined
async function share(s, pid, uid, role, owner = "u1") {
  const { invite } = await s.call("pfm.proj.invite.create", { pid, role }, owner);
  return s.call("pfm.proj.invite.accept", { token: invite.token, displayName: uid }, uid);
}

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

await t("ops are registered under pfm.", async () => {
  for (const op of ["pfm.proj.create", "pfm.proj.tx.add", "pfm.proj.charts", "pfm.proj.invite.accept", "pfm.proj.members.remove"])
    assert.ok(PFM_OPS.includes(op), op);
});

await t("create: needs init, validates, is idempotent, seals the description, writes owner rows", async () => {
  const s = setup();
  await assert.rejects(s.call("pfm.proj.create", { ...PROJ }), err("pfm_not_initialised"));
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" });
  await assert.rejects(s.call("pfm.proj.create", { ...PROJ, currency: "EUR" }), err("bad_currency"));
  await assert.rejects(s.call("pfm.proj.create", { ...PROJ, idemKey: "short" }), err("bad_idem_key"));
  const a = await s.call("pfm.proj.create", { ...PROJ, displayName: "Khalid" });
  assert.equal(a.project.targetBudget, 300000);
  assert.equal(a.project.description, "Two-room extension");
  const again = await s.call("pfm.proj.create", { ...PROJ, name: "Changed" });
  assert.equal(again.project.name, "House");
  const raw = s.fs.docs.get(`${ROOT}/pfmProjects/p_proj-key-0001`).data;
  assert.ok(raw.description && raw.description !== "Two-room extension");
  assert.equal(s.fs.docs.get(`${ROOT}/pfmProjects/p_proj-key-0001/members/u1`).data.role, "owner");
  assert.equal(s.fs.docs.get(`${ROOT}/pfm/u1/projectIndex/p_proj-key-0001`).data.role, "owner");
  assert.equal(s.fs.docs.get(`${ROOT}/pfm/u1/meta/projects`).data.schemaVersion, PROJECTS_SCHEMA_VERSION);
});

await t("update: stale rev refused, currency locked, audited", async () => {
  const s = await ready();
  const { project } = await s.call("pfm.proj.create", { ...PROJ });
  await assert.rejects(s.call("pfm.proj.update", { pid: project.id, rev: 9, name: "X" }), err("stale"));
  await assert.rejects(s.call("pfm.proj.update", { pid: project.id, rev: 1, currency: "USD" }), err("currency_locked"));
  const u = await s.call("pfm.proj.update", { pid: project.id, rev: 1, targetBudget: "3500", name: "House 2" });
  assert.equal(u.project.targetBudget, 350000);
  assert.equal(u.project.rev, 2);
  assert.ok(auditChain(s.fs).some((e) => e.action === "project.update"));
});

await t("status: whitelisted transitions only", async () => {
  const s = await ready();
  const { project } = await s.call("pfm.proj.create", { ...PROJ });
  await assert.rejects(s.call("pfm.proj.status", { pid: project.id, rev: 1, to: "completed" }), err("bad_transition"));
  const r = await s.call("pfm.proj.status", { pid: project.id, rev: 1, to: "active" });
  const hold = await s.call("pfm.proj.status", { pid: project.id, rev: r.project.rev, to: "on_hold" });
  assert.equal(hold.project.status, "on_hold");
});

await t("estimate: one open draft, line validation, approval freezes the baseline", async () => {
  const s = await ready();
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
  assert.equal(docsUnder(s.fs, `pfmProjects/${project.id}/estimates/${estimate.id}/lines/`).length, 2);
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
  assert.equal(typeof all.find((e) => e.id === co.estimate.id).rev, "number");   // the editor needs the revision to save
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
  assert.equal(cement.tx.description, "Cement delivery");
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
  let keys = (await s.call("pfm.proj.alerts.list", { pid })).items.map((a) => a.id);
  assert.ok(keys.some((k) => k.startsWith("budget:80:")));
  assert.ok(!keys.some((k) => k.startsWith("budget:100:")));
  // 2,600 + 500 = 3,100 of 3,000 (103 %): the 100 % alert fires once; the 80 % alert is not repeated
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-big-0002", kind: "expense", amount: "500.00", category: "other", occurredOn: "2026-11-05", description: "More" });
  let list = (await s.call("pfm.proj.alerts.list", { pid })).items;
  assert.equal(list.filter((a) => a.id.startsWith("budget:80:")).length, 1);
  const b100 = list.find((a) => a.id.startsWith("budget:100:"));
  assert.ok(b100 && b100.severity === "critical");
  const ack = await s.call("pfm.proj.alerts.ack", { pid, key: b100.id });
  assert.ok(ack.alert.acknowledgedAt);
  assert.equal((await s.call("pfm.proj.alerts.list", { pid, unacknowledged: true })).items.length, list.length - 1);
  const more = (await s.call("pfm.proj.tx.list", { pid })).items.find((t) => t.description === "More");
  await s.call("pfm.proj.tx.void", { pid, txId: more.id, reason: "Entered twice" });
  list = (await s.call("pfm.proj.alerts.list", { pid })).items;
  assert.ok(!list.some((a) => a.id.startsWith("budget:100:")), "100 % alert cleared after void");
  await assert.rejects(s.call("pfm.proj.tx.void", { pid, txId: "missing-tx-id", reason: "x" }), err("not_found"));
});

await t("concurrent entries on one project: both land, audit chain stays whole", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const real = s.d.fsCommit; let gate = null;
  s.d.fsCommit = async (tk, w) => { if (!gate) { gate = 1; await new Promise((r) => setTimeout(r, 5)); } return real(tk, w); };
  await Promise.all(["tx-race-0001", "tx-race-0002"].map((k) => handlePfmOp("pfm.proj.tx.add", "u1",
    { pid, idemKey: k, kind: "expense", amount: "10", category: "other", occurredOn: "2026-11-06", description: k }, s.env, s.d)));
  assert.equal((await s.call("pfm.proj.tx.list", { pid })).items.length, 2);
  assert.equal((await C.verifyChain(auditChain(s.fs))).ok, true);
});

// ---------- sharing ----------

await t("invite: an editor joins once; the same link cannot be used again; a stranger sees nothing", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const { invite } = await s.call("pfm.proj.invite.create", { pid, role: "editor" });
  assert.equal(invite.maxUses, 1);
  const j = await s.call("pfm.proj.invite.accept", { token: invite.token, displayName: "Sara" }, "u2");
  assert.equal(j.role, "editor");
  assert.equal(j.project.name, "House");                       // the name decrypts for the new member
  assert.equal(j.project.description, "Two-room extension");
  // A second person with the same link: no uses left
  await assert.rejects(s.call("pfm.proj.invite.accept", { token: invite.token }, "u3"), err("invite_used"));
  // Joining again is harmless
  assert.equal((await s.call("pfm.proj.invite.accept", { token: invite.token }, "u2")).role, "editor");
  // u3 has no membership: the project looks like it does not exist
  await assert.rejects(s.call("pfm.proj.get", { pid }, "u3"), err("not_found"));
  await assert.rejects(s.call("pfm.proj.invite.accept", { token: "x" }, "u3"), err("bad_invite"));
  assert.equal((await s.call("pfm.proj.list", {}, "u2")).items[0].role, "editor");
});

await t("invite: uses up to maxUses; expired invites are refused", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const { invite } = await s.call("pfm.proj.invite.create", { pid, role: "viewer", maxUses: 2 });
  await s.call("pfm.proj.invite.accept", { token: invite.token }, "u2");
  await s.call("pfm.proj.invite.accept", { token: invite.token }, "u3");
  await assert.rejects(s.call("pfm.proj.invite.accept", { token: invite.token }, "u4"), err("invite_used"));
  const old = await s.call("pfm.proj.invite.create", { pid, role: "viewer", days: 1 });
  s.fs.docs.get(`${ROOT}/pfmInvites/${old.invite.token}`).data.expiresAt = "2020-01-01T00:00:00.000Z";
  await assert.rejects(s.call("pfm.proj.invite.accept", { token: old.invite.token }, "u5"), err("invite_expired"));
  await assert.rejects(s.call("pfm.proj.invite.create", { pid, role: "owner" }), err("bad_role"));
  await assert.rejects(s.call("pfm.proj.invite.create", { pid, role: "viewer", maxUses: 11 }), err("bad_max_uses"));
});

await t("roles: a viewer reads but cannot write; an editor writes; only the owner manages people", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  await share(s, pid, "u2", "viewer");
  await share(s, pid, "u3", "editor");
  // viewer: reads yes, writes no
  assert.ok((await s.call("pfm.proj.health", { pid }, "u2")).health);
  assert.equal((await s.call("pfm.proj.charts", { pid }, "u2")).budget.target, 300000);
  await assert.rejects(s.call("pfm.proj.tx.add", { pid, idemKey: "tx-v-0001", kind: "expense", amount: "5", category: "other", occurredOn: "2026-11-02", description: "x" }, "u2"), err("forbidden"));
  await assert.rejects(s.call("pfm.proj.update", { pid, rev: 1, name: "x" }, "u2"), err("forbidden"));
  // editor: writes yes, people no
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-e-0001", kind: "expense", amount: "5", category: "other", occurredOn: "2026-11-02", description: "by editor" }, "u3");
  await assert.rejects(s.call("pfm.proj.invite.create", { pid, role: "viewer" }, "u3"), err("forbidden"));
  await assert.rejects(s.call("pfm.proj.members.role", { pid, uid: "u2", role: "editor" }, "u3"), err("forbidden"));
  await assert.rejects(s.call("pfm.proj.members.remove", { pid, uid: "u2" }, "u3"), err("forbidden"));
  // owner: promotes the viewer
  const role = await s.call("pfm.proj.members.role", { pid, uid: "u2", role: "editor" });
  assert.equal(role.member.role, "editor");
  assert.equal((await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-v-0002", kind: "expense", amount: "5", category: "other", occurredOn: "2026-11-02", description: "now allowed" }, "u2")).tx.description, "now allowed");
  await assert.rejects(s.call("pfm.proj.members.role", { pid, uid: "u1", role: "viewer" }), err("owner_role_fixed"));
  const members = (await s.call("pfm.proj.members.list", { pid }, "u3")).items;
  assert.equal(members[0].role, "owner");
  assert.equal(members.length, 3);
});

await t("leaving and removing: a member can leave; the owner cannot; the owner removes people", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  await share(s, pid, "u2", "viewer");
  await s.call("pfm.proj.members.remove", { pid }, "u2");                    // leave
  await assert.rejects(s.call("pfm.proj.get", { pid }, "u2"), err("not_found"));
  assert.equal(docsUnder(s.fs, `pfm/u2/projectIndex/`).length, 0);
  await assert.rejects(s.call("pfm.proj.members.remove", { pid }), err("owner_cannot_leave"));
  await share(s, pid, "u3", "viewer");
  await s.call("pfm.proj.members.remove", { pid, uid: "u3" });              // owner removes
  assert.equal((await s.call("pfm.proj.members.list", { pid })).items.length, 1);
});

await t("delete: owner only, needs the id as confirmation, removes the project for everyone", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  await share(s, pid, "u2", "editor");
  await assert.rejects(s.call("pfm.proj.delete", { pid, confirm: pid }, "u2"), err("forbidden"));
  await assert.rejects(s.call("pfm.proj.delete", { pid, confirm: "wrong" }), err("confirm_required"));
  await s.call("pfm.proj.delete", { pid, confirm: pid });
  assert.equal(docsUnder(s.fs, `pfmProjects/${pid}`).length, 0);
  assert.equal(docsUnder(s.fs, `pfm/u2/projectIndex/`).length, 0);
  await assert.rejects(s.call("pfm.proj.get", { pid }, "u2"), err("not_found"));
});

// ---------- copy to the personal ledger ----------

const GBP = { ...PROJ, idemKey: "proj-gbp-0001", currency: "GBP", targetBudget: "2,000.00" };

await t("copy to personal: a linked row in the caller's ledger; editing it is refused; voiding removes it", async () => {
  const s = await ready();
  const { project } = await s.call("pfm.proj.create", GBP);
  const pid = project.id;
  const r = await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cp-0001", kind: "expense", amount: "45.00", category: "other", occurredOn: "2026-11-07",
    description: "Cement bag", copyToPersonal: { categoryId: "c_food" } });
  assert.ok(r.personalCopyId);
  const personal = s.fs.docs.get(`${ROOT}/pfm/u1/tx/${r.personalCopyId}`).data;
  assert.equal(personal.projectRef.pid, pid);
  assert.equal(personal.amount, 4500);
  assert.equal(personal.categoryId, "c_food");
  const month = s.fs.docs.get(`${ROOT}/pfm/u1/months/2026-11`).data;
  assert.equal(month.expense, 4500);
  await assert.rejects(s.call("pfm.tx.update", { id: r.personalCopyId, rev: 1, amount: "1" }), err("linked_project_entry"));
  await assert.rejects(s.call("pfm.tx.delete", { id: r.personalCopyId, rev: 1 }), err("linked_project_entry"));
  await s.call("pfm.proj.tx.void", { pid, txId: r.tx.id, reason: "Duplicate" });
  assert.equal(s.fs.docs.get(`${ROOT}/pfm/u1/tx/${r.personalCopyId}`).data.deleted, true);
  assert.equal(s.fs.docs.get(`${ROOT}/pfm/u1/months/2026-11`).data.expense, 0);
});

await t("copy to personal: only expenses; a foreign currency needs the personal rate; a member's copy is not touched", async () => {
  const s = await ready();
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" }, "u2");   // a member copies to their own ledger
  const pid = await withBaseline(s, "u1", { idemKey: "proj-sdg-0001" });
  await assert.rejects(s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cp-0002", kind: "capital_injection", amount: "5", occurredOn: "2026-11-07", description: "x", copyToPersonal: { categoryId: "c_food" } }), err("copy_expense_only"));
  await assert.rejects(s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cp-0003", kind: "expense", amount: "5", lineKey: "mason", occurredOn: "2026-11-07", description: "x", copyToPersonal: { categoryId: "c_food" } }), err("fx_rate_required"));
  const ok = await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cp-0004", kind: "expense", amount: "5", lineKey: "mason", occurredOn: "2026-11-07", description: "Mason", copyToPersonal: { categoryId: "c_food" }, personalFxRate: "0.5" });
  // a member records and copies; the owner voids it: the member's personal copy is left, and the owner is told so
  await share(s, pid, "u2", "editor");
  const m = await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-cp-0005", kind: "expense", amount: "5", category: "other", occurredOn: "2026-11-08", description: "by u2", copyToPersonal: { categoryId: "c_food" }, personalFxRate: "0.5" }, "u2");
  assert.ok(m.personalCopyId);
  const v = await s.call("pfm.proj.tx.void", { pid, txId: m.tx.id, reason: "owner review" });
  assert.equal(v.personalCopyKept, true);
  assert.equal(s.fs.docs.get(`${ROOT}/pfm/u2/tx/${m.personalCopyId}`).data.deleted, false);
  assert.ok(ok.personalCopyId);
});

// ---------- charts ----------

await t("charts: estimate vs actual by category, monthly totals and a daily running balance", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-ch-0001", kind: "capital_injection", amount: "5,000.00", occurredOn: "2026-11-01", description: "Owner" });
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-ch-0002", kind: "expense", amount: "1,210.00", lineKey: "cement", quantity: "110", unit: "bag", occurredOn: "2026-11-03", description: "Cement" });
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-ch-0003", kind: "expense", amount: "400.00", category: "other", occurredOn: "2026-12-01", description: "Transport" });
  const c = await s.call("pfm.proj.charts", { pid });
  const raw = c.byCategory.find((x) => x.category === "raw_materials");
  assert.deepEqual([raw.estimated, raw.actual], [100000, 121000]);
  assert.deepEqual([c.byCategory.find((x) => x.category === "labor").estimated, c.byCategory.find((x) => x.category === "labor").actual], [135000, 0]);
  assert.deepEqual(c.byCategory.find((x) => x.category === "other").actual, 40000);
  assert.deepEqual(c.byMonth.map((m) => [m.month, m.actual, m.inflow]), [["2026-11", 121000, 500000], ["2026-12", 40000, 0]]);
  assert.deepEqual(c.daily.map((d) => d.balance), [500000, 379000, 339000]);
  assert.equal(c.budget.spent, 161000);
  assert.equal(c.budget.target, 300000);
});

// ---------- account deletion ----------

await t("purge: an owner's projects go; a member only loses membership; nothing of u1 remains", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const pid2 = await withBaseline(s, "u1", { idemKey: "proj-second-01" });
  await share(s, pid, "u2", "editor");
  await share(s, pid2, "u2", "viewer");
  await s.call("pfm.proj.invite.create", { pid: pid2, role: "viewer" });  // owner's invite stays until it expires
  // u2's own project, shared with u1
  await s.call("pfm.init", { baseCurrency: "GBP", tz: "Europe/Berlin" }, "u2");
  const { project: theirs } = await s.call("pfm.proj.create", { ...PROJ, idemKey: "proj-of-u2-01" }, "u2");
  await share(s, theirs.id, "u1", "viewer", "u2");
  const purgeColl = async (_t, rel, spend) => { for (const x of await s.fs.fsList(null, rel)) { if (!spend()) return false; await s.fs.fsCommit(null, [{ delete: x.name }]); } return true; };
  assert.equal(await purgePfm(s.d, "tok", "u1", () => true, purgeColl), true);
  assert.deepEqual([...s.fs.docs.keys()].filter((k) => k.includes("/u1")), []);
  assert.deepEqual(docsUnder(s.fs, `pfmProjects/${pid}`), []);
  assert.deepEqual(docsUnder(s.fs, `pfmProjects/${pid2}`), []);
  // u2's project is still there, and u1 is no longer one of its members
  assert.ok(s.fs.docs.get(`${ROOT}/pfmProjects/${theirs.id}`));
  assert.equal(s.fs.docs.get(`${ROOT}/pfmProjects/${theirs.id}/members/u1`), undefined);
});

// ---------- export ----------

await t("export: CSV defuses formulas, keeps numbers as numbers, and the viewer can export; a stranger cannot", async () => {
  const s = await ready();
  const { project } = await s.call("pfm.proj.create", { ...PROJ, name: "<b>Villa</b>", description: "x", idemKey: "proj-exp-0001" });
  const pid = project.id;
  await s.call("pfm.proj.estimate.create", { pid, idemKey: "est-exp-0001" }).then(async (r) => {
    await s.call("pfm.proj.estimate.lines", { pid, eid: r.estimate.id, rev: r.estimate.rev, lines: LINES });
    await s.call("pfm.proj.estimate.approve", { pid, eid: r.estimate.id, rev: r.estimate.rev + 1 });
  });
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-exp-0001", kind: "expense", amount: "12.00", category: "other", occurredOn: "2026-11-02", description: "=HYPERLINK(\"x\")" });
  const csv = (await s.call("pfm.proj.export", { pid })).csv;
  assert.ok(csv.includes("'=HYPERLINK"), "formula cell is defused");
  assert.ok(/,-?\d+\.\d\d,/.test(csv) && !csv.includes("'12.00"), "amounts stay numeric");
  assert.ok(csv.includes("Cement"));
  await share(s, pid, "u2", "viewer");
  assert.ok((await s.call("pfm.proj.export", { pid }, "u2")).csv.length > 0, "viewer exports");
  await assert.rejects(s.call("pfm.proj.export", { pid }, "u9"), err("not_found"));
});

await t("report: user text is escaped; the report is self-contained and carries the figures", async () => {
  const s = await ready();
  const pid = await withBaseline(s, "u1", { name: "<img src=x onerror=alert(1)>" });
  const { html, filename } = await s.call("pfm.proj.report", { pid, lang: "en" });
  assert.ok(!html.includes("<img src=x"), "project name is escaped");
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(html.includes("<meta charset=\"utf-8\">") && html.includes("dir=\"ltr\""));
  assert.ok(html.includes("2,350.00") || html.includes("2350.00"), "estimate total shown");
  assert.equal(filename, `project-${pid}.html`);
  assert.equal((await s.call("pfm.proj.report", { pid, lang: "ar" })).html.includes('dir="rtl"'), true);
});

// ---------- C284: dated prices, price history, attachments ----------
const C284_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const c284Pdf = (pad = 0) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(pad, 0x41), Buffer.from("\n%%EOF\n")]);
const uri = (type, b) => `data:${type};base64,${b.toString("base64")}`;
const todayBerlin = () => C.localDate("Europe/Berlin");

await t("C284 prices: each line is dated; an unchanged save keeps its stamp; a new price is logged; the log follows the line", async () => {
  const s = await ready();
  const { project } = await s.call("pfm.proj.create", PROJ);
  const pid = project.id;
  const { estimate } = await s.call("pfm.proj.estimate.create", { pid, idemKey: "est-key-0001" });
  await assert.rejects(s.call("pfm.proj.estimate.lines", { pid, eid: estimate.id, rev: estimate.rev, lines: [{ ...LINES[0], priceDate: "2999-01-01" }] }), err("bad_price_date"));
  await s.call("pfm.proj.estimate.lines", { pid, eid: estimate.id, rev: estimate.rev, lines: [{ ...LINES[0], priceDate: "2026-10-01", supplier: "Atbara Cement" }, LINES[1]] });
  let v = (await s.call("pfm.proj.variance", { pid, estimateId: estimate.id })).lines;
  const cem = v.find((l) => l.lineKey === "cement"), mas = v.find((l) => l.lineKey === "mason");
  assert.equal(cem.priceDate, "2026-10-01"); assert.equal(cem.supplier, "Atbara Cement"); assert.ok(cem.pricedAt); assert.equal(cem.priceChanges, 1);
  assert.equal(mas.priceDate, todayBerlin());                                           // no date given: today
  const raw = s.fs.docs.get(`${ROOT}/pfmProjects/${pid}/estimates/${estimate.id}/lines/cement`).data;
  assert.ok(raw.supplier !== "Atbara Cement" && !JSON.stringify(raw.priceLog).includes("Atbara"), "supplier sealed, in the line and in its log");
  // the same values again: same stamp, no new log entry
  await s.call("pfm.proj.estimate.lines", { pid, eid: estimate.id, rev: estimate.rev + 1, lines: [{ ...LINES[0], priceDate: "2026-10-01", supplier: "Atbara Cement" }, { ...LINES[1], priceDate: mas.priceDate }] });
  v = (await s.call("pfm.proj.variance", { pid, estimateId: estimate.id })).lines;
  assert.equal(v.find((l) => l.lineKey === "cement").pricedAt, cem.pricedAt); assert.equal(v.find((l) => l.lineKey === "cement").priceChanges, 1);
  // a new quote: logged
  await s.call("pfm.proj.estimate.lines", { pid, eid: estimate.id, rev: estimate.rev + 2, lines: [{ ...LINES[0], estUnitPrice: "12", priceDate: "2026-10-20", supplier: "Atbara Cement" }, { ...LINES[1], priceDate: mas.priceDate }] });
  await s.call("pfm.proj.estimate.approve", { pid, eid: estimate.id, rev: estimate.rev + 3 });
  // change order: the line and its log are copied into revision 2, then the price moves again
  const { estimate: e2 } = await s.call("pfm.proj.estimate.create", { pid, idemKey: "est-key-0002", fromBaseline: true, reason: "Cement went up" });
  await s.call("pfm.proj.estimate.lines", { pid, eid: e2.id, rev: e2.rev, lines: [{ ...LINES[0], estUnitPrice: "15", priceDate: "2026-11-05" }, { ...LINES[1], priceDate: mas.priceDate }] });
  await s.call("pfm.proj.estimate.approve", { pid, eid: e2.id, rev: e2.rev + 1 });
  // what was actually paid: 50 bags for 700.00 on 2026-11-06 → 14.00 a bag
  await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-key-c284-01", kind: "expense", amount: "700", occurredOn: "2026-11-06", description: "Cement", lineKey: "cement", quantity: "50", unit: "bag" });
  const h = (await s.call("pfm.proj.prices", { pid, lineKey: "cement" })).lines[0];
  assert.deepEqual(h.estimates.map((e) => [e.unitPrice, e.priceDate, e.revision]), [[1000, "2026-10-01", 1], [1200, "2026-10-20", 1], [1500, "2026-11-05", 2]]);
  assert.equal(h.estimates[0].supplier, "Atbara Cement"); assert.equal(h.estimates[2].supplier, null);
  assert.equal(h.changeBp, 5000);                                                       // 10.00 → 15.00
  assert.equal(h.actual[0].unitPrice, 1400);
  assert.equal(h.actualVsEstimateBp, -667);                                             // paid 14.00 against 15.00 in force that day
  // the first revision is untouched (approved revisions are read-only)
  const r1 = s.fs.docs.get(`${ROOT}/pfmProjects/${pid}/estimates/${estimate.id}/lines/cement`).data;
  assert.equal(r1.estUnitPrice, 1200); assert.equal(r1.priceLog.length, 2);
  const txs = (await s.call("pfm.proj.tx.list", { pid })).items;
  assert.equal(txs[0].unitPrice, 1400); assert.equal(txs[0].files, 0);
});

await t("C284 files: photo and multi-part PDF on a line and an entry, fixed dates, roles, removal keeps the record", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const eid = (await s.call("pfm.proj.get", { pid })).estimateId;
  await share(s, pid, "u2", "viewer");
  const big = c284Pdf(900 * 1024);                                                      // 3 parts
  const add = (extra, uid = "u1") => s.call("pfm.proj.file.add", { pid, idemKey: "file-key-" + Math.random().toString(36).slice(2, 10), kind: "quote", docDate: "2026-10-03", ...extra }, uid);
  await assert.rejects(add({ target: { type: "line", estimateId: eid, lineKey: "cement" }, data: uri("image/png", C284_PNG) }, "u2"), err("forbidden"));
  await assert.rejects(add({ target: { type: "line", estimateId: eid, lineKey: "nope" }, data: uri("image/png", C284_PNG) }), err("not_found"));
  await assert.rejects(add({ target: { type: "line", estimateId: eid, lineKey: "cement" }, data: uri("image/png", C284_PNG), docDate: "2999-01-01" }), err("bad_price_date"));
  await assert.rejects(add({ target: { type: "line", estimateId: eid, lineKey: "cement" }, data: uri("application/pdf", C284_PNG) }), err("bad_file"));
  await assert.rejects(add({ target: { type: "tx", txId: "x_nothing" }, data: uri("image/png", C284_PNG) }), err("not_found"));
  await assert.rejects(add({ kind: "photo", target: { type: "line", estimateId: eid, lineKey: "cement" }, data: uri("image/png", C284_PNG), quotedUnitPrice: "9" }), err("bad_quote"));
  const q = (await add({ target: { type: "line", estimateId: eid, lineKey: "cement" }, data: uri("application/pdf", big), name: "Atbara quote Oct.pdf", quotedUnitPrice: "9.50" })).file;
  assert.equal(q.type, "application/pdf"); assert.equal(q.size, big.length); assert.equal(q.docDate, "2026-10-03"); assert.ok(q.uploadedAt); assert.equal(q.uploadedBy, "u1");
  assert.equal(s.fs.docs.get(`${ROOT}/pfmProjects/${pid}/files/${q.id}`).data.parts, 3);
  assert.ok(![...s.fs.docs.values()].some((e) => JSON.stringify(e.data).includes("Atbara quote")), "file names are sealed");
  // the viewer can list and open
  const got = await s.call("pfm.proj.file.get", { pid, fid: q.id }, "u2");
  assert.equal(got.data, uri("application/pdf", big));
  const { tx } = await s.call("pfm.proj.tx.add", { pid, idemKey: "tx-key-c284-02", kind: "expense", amount: "100", occurredOn: "2026-11-02", description: "Cement", lineKey: "cement", quantity: "10", unit: "bag" });
  const rc = (await add({ kind: "receipt", target: { type: "tx", txId: tx.id }, data: uri("image/png", C284_PNG), docDate: "2026-11-02" })).file;
  assert.equal((await s.call("pfm.proj.file.list", { pid, target: { type: "tx", txId: tx.id } })).items.length, 1);
  assert.equal((await s.call("pfm.proj.tx.list", { pid })).items[0].files, 1);
  assert.equal((await s.call("pfm.proj.variance", { pid })).lines.find((l) => l.lineKey === "cement").files, 1);
  // quotes feed the price history
  assert.deepEqual((await s.call("pfm.proj.prices", { pid, lineKey: "cement" })).lines[0].quotes.map((x) => [x.unitPrice, x.docDate]), [[950, "2026-10-03"]]);
  // removal: needs a reason, keeps who/when/why, drops the bytes
  await assert.rejects(s.call("pfm.proj.file.remove", { pid, fid: rc.id }), err("reason_required"));
  const rm = (await s.call("pfm.proj.file.remove", { pid, fid: rc.id, reason: "Wrong receipt" })).file;
  assert.ok(rm.removedAt); assert.equal(rm.removeReason, "Wrong receipt"); assert.equal(rm.docDate, "2026-11-02");
  assert.equal(docsUnder(s.fs, `pfmProjects/${pid}/files/${rc.id}/parts`).length, 0);
  await assert.rejects(s.call("pfm.proj.file.get", { pid, fid: rc.id }), err("file_removed"));
  assert.equal((await s.call("pfm.proj.file.list", { pid })).items.length, 1);
  assert.equal((await s.call("pfm.proj.file.list", { pid, withRemoved: true })).items.length, 2);
  // an editor who never set up their own accountant can still attach (dates fall back to UTC)
  await share(s, pid, "u3", "editor");
  assert.ok((await add({ kind: "photo", target: { type: "project" }, data: uri("image/png", C284_PNG), docDate: "2026-11-01" }, "u3")).file.id);
  // the same idemKey twice: one file
  const key = "file-key-same0001";
  await s.call("pfm.proj.file.add", { pid, idemKey: key, kind: "photo", target: { type: "project" }, docDate: "2026-11-01", data: uri("image/png", C284_PNG) });
  await s.call("pfm.proj.file.add", { pid, idemKey: key, kind: "photo", target: { type: "project" }, docDate: "2026-11-01", data: uri("image/png", C284_PNG) });
  assert.equal((await s.call("pfm.proj.file.list", { pid, target: { type: "project" } })).items.length, 2);
  // audit entries
  assert.ok(auditChain(s.fs).some((e) => e.action === "project.file.add") && auditChain(s.fs).some((e) => e.action === "project.file.remove"));
  // deleting the project removes the files and their parts
  await s.call("pfm.proj.delete", { pid, confirm: pid });
  assert.equal(docsUnder(s.fs, `pfmProjects/${pid}`).length, 0);
});

await t("C284 report.pdf: HTML for the phone when Browser Rendering is not set up", async () => {
  const s = await ready();
  const pid = await withBaseline(s);
  const r = await s.call("pfm.proj.report.pdf", { pid, lang: "en" });
  assert.equal(r.pdf, null); assert.equal(r.via, "device"); assert.match(r.filename, /^project-.*\.pdf$/); assert.match(r.html, /<html/);
});

console.log(process.exitCode ? "FAILED" : `projects-worker: ${n} passed`);
