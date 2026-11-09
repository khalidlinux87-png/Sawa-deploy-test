// Sawa Personal Accountant: Worker operations (phase P1: settings, categories, ledger, monthly rollups, audit).
// worker-3.js routes every "pfm.*" op here and passes its own Firestore helpers as `d`, so this file keeps
// the Worker's retry, token and path-safety behaviour and can be tested in Node against an in-memory Firestore.
//
// Every mutation is ONE Firestore commit: the row, the month rollup increments, and the audit entry together.
// The audit head carries an updateTime precondition, so two concurrent writes cannot fork the hash chain;
// the loser re-reads and retries.
import * as C from "./pfm-core.mjs";
import { renderInvoiceHtml } from "./invoice-html.mjs";
import * as J from "./projects-core.mjs";
import { migrateProjects } from "./projects-migrations.mjs";

const MAX_TRIES = 4;
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const OPS = {
  "pfm.get": opGet,
  "pfm.init": opInit,
  "pfm.settings.set": opSettingsSet,
  "pfm.cat.upsert": opCatUpsert,
  "pfm.cat.archive": opCatArchive,
  "pfm.tx.add": opTxAdd,
  "pfm.tx.update": opTxUpdate,
  "pfm.tx.delete": opTxDelete,
  "pfm.tx.list": opTxList,
  "pfm.summary": opSummary,
  "pfm.fx.last": opFxLast,
  "pfm.audit.list": opAuditList,
  // P2
  "pfm.tx.confirm": opTxConfirm,
  "pfm.budget.set": opBudgetSet,
  "pfm.budget.delete": opBudgetDelete,
  "pfm.budget.list": opBudgetList,
  "pfm.alerts.list": opAlertsList,
  "pfm.alerts.read": opAlertsRead,
  "pfm.import.prefs.get": opImportPrefsGet,
  "pfm.import.prefs.set": opImportPrefsSet,
  "pfm.recurring.upsert": opRecurringUpsert,
  "pfm.recurring.pause": opRecurringPause,
  "pfm.recurring.delete": opRecurringDelete,
  "pfm.rule.upsert": opRuleUpsert,
  "pfm.rule.delete": opRuleDelete,
  // P3: invoices
  "pfm.biz.get": opBizGet,
  "pfm.biz.set": opBizSet,
  "pfm.logo.set": opLogoSet,
  "pfm.logo.delete": opLogoDelete,
  "pfm.account.upsert": opAccountUpsert,
  "pfm.account.archive": opAccountArchive,
  "inv.preview": opInvPreview,
  "inv.create": opInvSave,
  "inv.update": opInvSave,
  "inv.delete": opInvDelete,
  "inv.get": opInvGet,
  "inv.list": opInvList,
  "inv.send": opInvSend,
  "inv.cancel": opInvCancel,
  "inv.markPaid": opInvMarkPaid,
  "inv.html": opInvHtml,
  // P4
  "inv.claim.decide": opClaimDecide,
  "inv.claim.proof": opClaimProof,
  "inv.link": opInvLink,
  // P5
  "pfm.tx.receipt.set": opReceiptSet,
  "pfm.tx.receipt.get": opReceiptGet,
  "pfm.tx.receipt.delete": opReceiptDelete,
  "pfm.export": opExport,
};
export const PFM_OPS = Object.keys(OPS);

export async function handlePfmOp(op, uid, payload, env, d) {
  const fn = OPS[op];
  if (!fn) throw new Error("unknown op: " + op);
  if (!env.PFM_KEK_v1) throw new Error("pfm_not_configured");
  const x = { uid, env, d, p: payload && typeof payload === "object" ? payload : {}, token: await d.getToken(env) };
  try { return await fn(x); }
  catch (e) {
    // PfmError codes are safe to show; the Worker passes short messages through publicErr unchanged.
    if (e instanceof C.PfmError) throw new Error(e.code + (e.message && e.message !== e.code ? ": " + String(e.message).slice(0, 80) : ""));
    throw e;
  }
}

// ---------- small helpers ----------

const P = (x, rel) => x.d.DOC_ROOT + "/" + rel;
const now = () => new Date().toISOString();
const rid = (n = 12) => { const a = crypto.getRandomValues(new Uint8Array(n)); return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };
function fieldsOf(x, obj) { const f = {}; for (const k in obj) if (obj[k] !== undefined) f[k] = x.d.toFsValue(obj[k]); return f; }
function js(x, doc) {
  if (!doc) return null;
  const o = {}; for (const k in doc.fields || {}) o[k] = x.d.fsToJs(doc.fields[k]);
  o.id = doc.name.split("/").pop(); o._updateTime = doc.updateTime;
  return o;
}
const strip = (o) => { const r = { ...o }; delete r._updateTime; return r; };
const txt = (v, max, name) => {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new C.PfmError("bad_" + name);
  const s = v.trim();
  if (s.length > max) throw new C.PfmError("too_long", name);
  return s || null;
};
const isConflict = (e) => /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/.test(String(e && e.message));

async function settingsOf(x, required = true) {
  const s = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}`));
  if (!s && required) throw new C.PfmError("pfm_not_initialised");
  return s;
}
async function categoryMap(x) {
  const docs = await x.d.fsList(x.token, `pfm/${x.uid}/categories`);
  return new Map(docs.map((dd) => { const c = js(x, dd); return [c.id, c]; }));
}

// Runs build() and commits its writes together with audit entries. build() is re-run on a conflict,
// so it must read everything it needs itself. It returns { writes, audit: [{action, ref, before?, after?}], result }
// or { result } alone for a no-op (e.g. a repeated request).
async function commitAudited(x, build) {
  for (let attempt = 1; ; attempt++) {
    const b = await build();
    if (!b.writes) return b.result;
    const headDoc = await x.d.fsGet(x.token, `audit/${x.uid}`);
    const head = headDoc ? js(x, headDoc) : null;
    let prev = head ? { seq: head.headSeq, hash: head.headHash } : null;
    const writes = [...b.writes];
    for (const a of b.audit || []) {
      const e = await C.auditEntry(prev, { at: now(), actor: x.uid, ...a });
      writes.push({ update: { name: P(x, `audit/${x.uid}/log/${String(e.seq).padStart(10, "0")}`), fields: fieldsOf(x, e) }, currentDocument: { exists: false } });
      prev = e;
    }
    if (prev && (!head || prev.seq !== head.headSeq))
      writes.push({ update: { name: P(x, `audit/${x.uid}`), fields: fieldsOf(x, { headSeq: prev.seq, headHash: prev.hash, updatedAt: now() }) },
        currentDocument: headDoc ? { updateTime: headDoc.updateTime } : { exists: false } });
    try { await x.d.fsCommit(x.token, writes); return b.result; }
    catch (e) { if (!isConflict(e) || attempt >= MAX_TRIES) throw isConflict(e) ? new C.PfmError("busy") : e; }
  }
}

// increments for the month rollups: rollupDiff output -> transform writes
function rollupWrites(x, diff) {
  return Object.entries(diff).map(([m, fields]) => ({
    transform: { document: P(x, `pfm/${x.uid}/months/${m}`),
      fieldTransforms: fields.map(([fieldPath, v]) => ({ fieldPath, increment: { integerValue: String(v) } })) },
  }));
}

// sealed (encrypted) free-text fields
const SEALED = ["note", "counterparty"];
const keys = (x) => ({ 1: x.env.PFM_KEK_v1, ...(x.env.PFM_KEK_v2 ? { 2: x.env.PFM_KEK_v2 } : {}) });
const curKey = (x) => (x.env.PFM_KEK_v2 ? [x.env.PFM_KEK_v2, 2] : [x.env.PFM_KEK_v1, 1]);
const seal = (x, v) => (v == null ? null : C.sealField(v, x.uid, ...curKey(x)));
async function present(x, tx) {
  const o = strip(tx);
  for (const k of SEALED) o[k] = o[k] ? await C.openField(o[k], x.uid, keys(x)).catch(() => null) : null;
  return o;
}

// ---------- settings and categories ----------

function checkTz(tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { throw new C.PfmError("bad_tz", String(tz)); } }

async function opGet(x) {
  const s = await settingsOf(x, false);
  if (!s) return { settings: null };
  const today = C.localDate(s.tz), month = C.budgetMonth(today, s.monthStartDay);
  // Recurring entries that fell due since the last visit appear now (the cron also does this and sends a reminder).
  await materialise(x, s, today).catch(() => null);
  const [catMap, rules, recurring, suggested, alerts] = await Promise.all([categoryMap(x), rulesOf(x), recurringOf(x),
    x.d.fsQuerySub(x.token, `pfm/${x.uid}`, "tx", [["status", "EQUAL", "suggested"]], 100), unreadAlerts(x, month)]);
  const cats = [...catMap.values()].map(strip).sort((a, b) => a.order - b.order);
  return { settings: strip(s), categories: cats, today, month,
    rules: rules.map(strip), recurring: await Promise.all(recurring.map((r) => present(x, r))),
    suggestedCount: suggested.map((dd) => js(x, dd)).filter((t) => !t.deleted).length, alerts, claimsCount: await claimsOf(x) };
}

async function opInit(x) {
  const p = x.p;
  C.currencyExp(p.baseCurrency);
  checkTz(p.tz);
  const locale = p.locale === "en" ? "en" : "ar";
  const startDay = p.monthStartDay == null ? 1 : p.monthStartDay;
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31) throw new C.PfmError("bad_start_day");
  await commitAudited(x, async () => {
    if (await x.d.fsGet(x.token, `pfm/${x.uid}`)) return { result: null };   // already set up: just return state
    const at = now();
    const settings = { baseCurrency: p.baseCurrency, tz: p.tz, locale, monthStartDay: startDay, keyVersion: curKey(x)[1], hasTx: false, createdAt: at };
    const writes = [{ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, settings) }, currentDocument: { exists: false } }];
    for (const c of C.DEFAULT_CATEGORIES)
      writes.push({ update: { name: P(x, `pfm/${x.uid}/categories/${c.id}`), fields: fieldsOf(x, { ...c, id: undefined, createdAt: at }) } });
    return { writes, audit: [{ action: "pfm.init", ref: `pfm/${x.uid}`, after: settings }], result: null };
  });
  return opGet(x);
}

async function opSettingsSet(x) {
  const p = x.p;
  await commitAudited(x, async () => {
    const s = await settingsOf(x);
    const next = {};
    if (p.tz != null) next.tz = checkTz(p.tz);
    if (p.locale != null) next.locale = p.locale === "en" ? "en" : "ar";
    if (p.baseCurrency != null && p.baseCurrency !== s.baseCurrency) {
      C.currencyExp(p.baseCurrency);
      // P1: changing the base currency or month start after the first entry would need a full re-base of
      // history (designed in §5.8, not built yet), so it is refused instead of leaving wrong totals.
      if (s.hasTx) throw new C.PfmError("locked_after_first_entry", "baseCurrency");
      next.baseCurrency = p.baseCurrency;
    }
    if (p.monthStartDay != null && p.monthStartDay !== s.monthStartDay) {
      if (!Number.isInteger(p.monthStartDay) || p.monthStartDay < 1 || p.monthStartDay > 31) throw new C.PfmError("bad_start_day");
      if (s.hasTx) throw new C.PfmError("locked_after_first_entry", "monthStartDay");
      next.monthStartDay = p.monthStartDay;
    }
    if (!Object.keys(next).length) return { result: null };
    next.updatedAt = now();
    return {
      writes: [{ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, next) }, updateMask: { fieldPaths: Object.keys(next) }, currentDocument: { updateTime: s._updateTime } }],
      audit: [{ action: "settings.update", ref: `pfm/${x.uid}`, before: Object.fromEntries(Object.keys(next).map((k) => [k, s[k] ?? null])), after: next }],
      result: null,
    };
  });
  return opGet(x);
}

const COLOR = /^#[0-9a-fA-F]{6}$/, ICON = /^[a-z]{1,20}$/;
async function opCatUpsert(x) {
  const p = x.p;
  const name = txt(p.name, 40, "name"), nameAr = txt(p.nameAr, 40, "nameAr");
  if (p.icon != null && !ICON.test(p.icon)) throw new C.PfmError("bad_icon");
  if (p.color != null && !COLOR.test(p.color)) throw new C.PfmError("bad_color");
  let out;
  await commitAudited(x, async () => {
    await settingsOf(x);
    const cats = await categoryMap(x);
    const old = p.id ? cats.get(p.id) : null;
    if (p.id && !old) throw new C.PfmError("not_found", "category");
    let next;
    if (old) {
      // kind is fixed once created: rows already booked under it would otherwise change meaning
      next = { ...strip(old), ...(name && { name }), ...(nameAr && { nameAr }), ...(p.icon && { icon: p.icon }), ...(p.color && { color: p.color }),
        ...(Number.isInteger(p.order) && { order: p.order }), updatedAt: now() };
    } else {
      if (!name) throw new C.PfmError("bad_name");
      if (p.kind !== "income" && p.kind !== "expense") throw new C.PfmError("bad_kind");
      if (cats.size >= 100) throw new C.PfmError("too_many_categories");
      next = { id: "u_" + rid(10), kind: p.kind, name, nameAr: nameAr || name, icon: p.icon || "tag", color: p.color || "#64748b",
        order: Math.max(0, ...[...cats.values()].map((c) => c.order || 0)) + 1, system: false, archived: false, createdAt: now() };
    }
    const id = next.id; delete next.id;
    out = { id, ...next };
    return {
      writes: [{ update: { name: P(x, `pfm/${x.uid}/categories/${id}`), fields: fieldsOf(x, next) }, currentDocument: old ? { updateTime: old._updateTime } : { exists: false } }],
      audit: [{ action: old ? "category.update" : "category.add", ref: `categories/${id}`, before: old ? strip(old) : undefined, after: next }],
      result: null,
    };
  });
  return { category: out };
}

async function opCatArchive(x) {
  const archived = x.p.archived !== false;
  await commitAudited(x, async () => {
    const c = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/categories/${segId(x.p.id)}`));
    if (!c) throw new C.PfmError("not_found", "category");
    if (c.archived === archived) return { result: null };
    return {
      writes: [{ update: { name: P(x, `pfm/${x.uid}/categories/${c.id}`), fields: fieldsOf(x, { archived, updatedAt: now() }) }, updateMask: { fieldPaths: ["archived", "updatedAt"] }, currentDocument: { updateTime: c._updateTime } }],
      audit: [{ action: archived ? "category.archive" : "category.restore", ref: `categories/${c.id}` }],
      result: null,
    };
  });
  return { id: x.p.id, archived };
}
function segId(id) { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new C.PfmError("bad_id"); return id; }

// ---------- ledger ----------

// Builds a ledger row from user input. `base` (optional) is the existing row for an update.
async function buildTx(x, s, cats, input, base) {
  const kind = input.kind ?? base?.kind;
  if (kind !== "income" && kind !== "expense") throw new C.PfmError("bad_kind");
  const currency = input.currency ?? base?.currency ?? s.baseCurrency;
  C.currencyExp(currency);
  const amount = input.amount != null ? C.toMinor(input.amount, currency) : base?.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new C.PfmError("bad_amount");
  const categoryId = input.categoryId ?? base?.categoryId;
  const cat = cats.get(categoryId);
  if (!cat) throw new C.PfmError("bad_category");
  if (cat.kind !== kind) throw new C.PfmError("category_kind_mismatch");
  if (cat.archived && categoryId !== base?.categoryId) throw new C.PfmError("category_archived");
  const date = input.date ?? base?.date;
  const month = C.budgetMonth(date, s.monthStartDay);
  if (date < "2000-01-01" || date > "2100-12-31") throw new C.PfmError("bad_date");

  // Base-currency amount: same currency needs no rate; otherwise the rate the user typed, or "pending".
  let fxRate = null, baseAmount = null, fxSource = "pending";
  if (currency === s.baseCurrency) { fxRate = "1"; baseAmount = amount; fxSource = "same"; }
  else {
    const changed = input.amount != null || input.currency != null;
    const rate = input.fxRate != null && input.fxRate !== "" ? String(input.fxRate) : (!changed && base?.fxRate) || null;
    if (rate) { baseAmount = C.convert(amount, currency, s.baseCurrency, rate); fxRate = rate; fxSource = "manual"; }
  }
  const sealOr = async (k, max) => (input[k] !== undefined ? await seal(x, txt(input[k], max, k)) : base?.[k] ?? null);
  return { kind, amount, currency, baseAmount, fxRate, fxSource, categoryId, date, month,
    note: await sealOr("note", 300), counterparty: await sealOr("counterparty", 80),
    source: base?.source || (input.source === "import" ? "import" : "manual"), status: input.status || base?.status || "booked", deleted: false, hasReceipt: !!base?.hasReceipt };
}

async function opTxAdd(x) {
  const p = x.p;
  let settingsForAlerts = null;
  // An imported bank transaction carries its reference: the row id comes from it, so the same transfer imported twice
  // (the same screenshot again, or its SMS) is one entry, and the second add answers duplicate: true.
  const fromImport = p.ref != null;
  if (!fromImport && !ID_RE.test(p.idemKey || "")) throw new C.PfmError("bad_idem_key");
  const id = fromImport ? await C.importRefId(p.ref.issuer, p.ref.id, x.uid, x.env.PFM_KEK_v1)
    : "t_" + p.idemKey;                   // the client's idempotency key IS the row id: a retry hits exists:false
  let out, dup = false;
  await commitAudited(x, async () => {
    const existing = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/tx/${id}`));
    if (existing) { out = existing; dup = fromImport; return { result: null }; }
    const s = await settingsOf(x), cats = await categoryMap(x);
    let input = fromImport ? { ...p, source: "import" } : p, auto = false;
    if (!p.categoryId && (p.counterparty || p.note)) {
      const m = C.matchCategoryRule(await rulesOf(x), { kind: p.kind, counterparty: p.counterparty, note: p.note });
      if (m && cats.get(m.categoryId)?.kind === p.kind) { input = { ...p, categoryId: m.categoryId }; auto = true; }
    }
    const tx = { ...(await buildTx(x, s, cats, input, null)), autoCategorized: auto, rev: 1, createdAt: now(), updatedAt: now() };
    settingsForAlerts = s;
    out = { id, ...tx };
    const writes = [{ update: { name: P(x, `pfm/${x.uid}/tx/${id}`), fields: fieldsOf(x, tx) }, currentDocument: { exists: false } },
      ...rollupWrites(x, C.rollupDiff(null, tx))];
    if (tx.fxSource === "manual") writes.push(fxLastWrite(x, tx, s.baseCurrency));
    if (!s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
    return { writes, audit: [{ action: "tx.add", ref: `tx/${id}`, after: auditView(tx) }], result: null };
  });
  const alerts = settingsForAlerts ? await checkAlerts(x, settingsForAlerts, [out]) : [];
  return { tx: await present(x, out), alerts, ...(fromImport ? { duplicate: dup } : {}) };
}
const fxLastWrite = (x, tx, base) => ({ update: { name: P(x, `pfm/${x.uid}/fxLast/${tx.currency}_${base}`), fields: fieldsOf(x, { rate: tx.fxRate, at: now() }) } });
// Audit keeps amounts, category, dates and the sealed text (still encrypted).
const auditView = (t) => ({ kind: t.kind, amount: t.amount, currency: t.currency, baseAmount: t.baseAmount, fxRate: t.fxRate, categoryId: t.categoryId,
  date: t.date, note: t.note, counterparty: t.counterparty, deleted: t.deleted, status: t.status });
function changed(a, b) {
  const before = {}, after = {};
  for (const k of Object.keys(auditView(b))) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) { before[k] = a[k] ?? null; after[k] = b[k] ?? null; }
  return { before, after };
}

async function loadTxForEdit(x) {
  const id = segId(x.p.id);
  const old = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/tx/${id}`));
  if (!old || old.deleted) throw new C.PfmError("not_found", "transaction");
  if (old.projectRef) throw new C.PfmError("linked_project_entry", "edit this entry in its project");
  if (x.p.rev !== old.rev) throw new C.PfmError("stale", "reload and try again");
  return old;
}

async function opTxUpdate(x) {
  let out, prevRow = null, sAlerts = null;
  await commitAudited(x, async () => {
    const old = await loadTxForEdit(x);
    const s = await settingsOf(x), cats = await categoryMap(x);
    const input = {};
    for (const k of ["kind", "amount", "currency", "fxRate", "categoryId", "date", "note", "counterparty"]) if (x.p[k] !== undefined) input[k] = x.p[k];
    const nx = { ...(await buildTx(x, s, cats, input, old)), rev: old.rev + 1, createdAt: old.createdAt, updatedAt: now() };
    const { before, after } = changed(old, nx);
    out = { id: old.id, ...nx };
    if (!Object.keys(after).length) { out = old; return { result: null }; }
    const writes = [{ update: { name: P(x, `pfm/${x.uid}/tx/${old.id}`), fields: fieldsOf(x, nx) }, currentDocument: { updateTime: old._updateTime } },
      ...rollupWrites(x, C.rollupDiff(old, nx))];
    if (nx.fxSource === "manual" && nx.fxRate !== old.fxRate) writes.push(fxLastWrite(x, nx, s.baseCurrency));
    prevRow = old; sAlerts = s;
    return { writes, audit: [{ action: "tx.update", ref: `tx/${old.id}`, before, after }], result: null };
  });
  const alerts = sAlerts ? await checkAlerts(x, sAlerts, [prevRow, out]) : [];
  return { tx: await present(x, out), alerts };
}

async function opTxDelete(x) {
  await commitAudited(x, async () => {
    const old = await loadTxForEdit(x);
    const nx = { ...strip(old), deleted: true, hasReceipt: false, rev: old.rev + 1, updatedAt: now() }; delete nx.id;
    return {
      writes: [{ update: { name: P(x, `pfm/${x.uid}/tx/${old.id}`), fields: fieldsOf(x, nx) }, currentDocument: { updateTime: old._updateTime } },
        ...rollupWrites(x, C.rollupDiff(old, nx)),
        ...(old.hasReceipt ? [{ delete: P(x, `pfm/${x.uid}/files/r_${old.id}`) }] : [])],
      audit: [{ action: "tx.delete", ref: `tx/${old.id}`, before: auditView(old) }],
      result: null,
    };
  });
  return { id: x.p.id, deleted: true };
}

// One budget month at a time. Equality-only query, so no composite index is needed; sorted here.
const LIST_CAP = 1000;
async function opTxList(x) {
  const s = await settingsOf(x);
  const month = x.p.month || C.budgetMonth(C.localDate(s.tz), s.monthStartDay);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new C.PfmError("bad_month");
  const docs = await x.d.fsQuerySub(x.token, `pfm/${x.uid}`, "tx", [["month", "EQUAL", month]], LIST_CAP);
  let rows = docs.map((dd) => js(x, dd)).filter((t) => !t.deleted);
  if (x.p.categoryId) rows = rows.filter((t) => t.categoryId === x.p.categoryId);
  rows.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  return { month, items: await Promise.all(rows.map((t) => present(x, t))), truncated: docs.length >= LIST_CAP };
}

// ---------- analytics ----------

function monthRange(from, to) {
  const ok = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  if (!ok(from) || !ok(to) || from > to) throw new C.PfmError("bad_month");
  const out = []; let [y, m] = from.split("-").map(Number);
  for (;;) { const k = `${y}-${String(m).padStart(2, "0")}`; out.push(k); if (k === to || out.length > 24) break; if (++m === 13) { m = 1; y++; } }
  if (out.length > 24) throw new C.PfmError("range_too_long", "24 months max");
  return out;
}

async function opSummary(x) {
  const s = await settingsOf(x);
  const cur = C.budgetMonth(C.localDate(s.tz), s.monthStartDay);
  const to = x.p.to || cur, focus = x.p.focus || to;
  let from = x.p.from;
  if (!from) { const [y, m] = to.split("-").map(Number); const d = new Date(Date.UTC(y, m - 6, 1)); from = d.toISOString().slice(0, 7); }
  const months = monthRange(from, to);
  if (!months.includes(focus)) months.push(focus);
  const docs = await Promise.all(months.map((m) => x.d.fsGet(x.token, `pfm/${x.uid}/months/${m}`)));
  const byMonth = new Map(months.map((m, i) => [m, js(x, docs[i]) || {}]));
  const row = (m) => {
    const r = byMonth.get(m), income = r.income || 0, expense = r.expense || 0, net = income - expense;
    return { month: m, income, expense, net, savingsRateBp: income > 0 ? Math.round((net * 10000) / income) : null, txCount: r.txCount || 0, ratePending: r.ratePending || 0 };
  };
  const f = byMonth.get(focus);
  const cats = Object.entries(f.cat || {}).map(([categoryId, v]) => ({ categoryId, expense: v.e || 0, income: v.i || 0, count: v.n || 0 }))
    .filter((c) => c.expense || c.income || c.count);
  const totalE = cats.reduce((a, c) => a + Math.max(c.expense, 0), 0);
  for (const c of cats) c.shareBp = totalE > 0 && c.expense > 0 ? Math.round((c.expense * 10000) / totalE) : 0;
  cats.sort((a, b) => b.expense - a.expense || b.income - a.income);
  const days = Object.entries(f.day || {}).map(([k, v]) => ({ day: Number(k.slice(1)), income: v.i || 0, expense: v.e || 0 })).sort((a, b) => a.day - b.day);
  return { baseCurrency: s.baseCurrency, currentMonth: cur, focus: { ...row(focus), byCategory: cats, days },
    months: months.filter((m) => m >= from && m <= to).map(row) };
}

async function opFxLast(x) {
  const s = await settingsOf(x);
  const from = x.p.from; C.currencyExp(from);
  const d = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/fxLast/${from}_${s.baseCurrency}`));
  return { from, to: s.baseCurrency, rate: d ? d.rate : null, at: d ? d.at : null };
}

// The user's own recent history, newest first, with the chain checked over the returned window.
async function opAuditList(x) {
  const head = js(x, await x.d.fsGet(x.token, `audit/${x.uid}`));
  if (!head) return { entries: [], verified: true, headSeq: 0 };
  const n = Math.min(Math.max(Number(x.p.limit) || 20, 1), 20);
  const seqs = []; for (let q = head.headSeq; q > 0 && seqs.length < n; q--) seqs.push(q);
  const docs = await Promise.all(seqs.map((q) => x.d.fsGet(x.token, `audit/${x.uid}/log/${String(q).padStart(10, "0")}`)));
  const entries = docs.map((dd) => strip(js(x, dd))).map((e) => { delete e.id; return e; });
  // Window check: every entry hashes correctly and links to the next older one. The head must match.
  let verified = entries.length > 0 && entries[0].hash === head.headHash;
  const asc = [...entries].reverse();
  for (let i = 0; i < asc.length && verified; i++) {
    const { hash, ...rest } = asc[i];
    const prev = i ? asc[i - 1] : null;
    const chk = await C.auditEntry(prev ? { seq: prev.seq, hash: prev.hash } : asc[i].seq === 1 ? null : { seq: asc[i].seq - 1, hash: asc[i].prevHash }, (({ seq, prevHash, ...b }) => b)(rest));
    if (chk.hash !== hash || (prev && rest.prevHash !== prev.hash)) verified = false;
  }
  return { entries: entries.map(({ hash, prevHash, ...e }) => e), verified, headSeq: head.headSeq };
}

// ---------- account deletion ----------

// Called by the Worker's purge job. Returns true when everything is gone (false = budget ran out; the job retries).
export async function purgePfm(d, token, uid, spend, purgeColl) {
  for (const c of ["tx", "categories", "months", "fxLast", "recurring", "budgets", "alerts", "rules", "idem", "payoutAccounts", "files", "invoiceNumbers", "import", "meta"])
    if (!(await purgeColl(token, `pfm/${uid}/${c}`, spend))) return false;
  if (!(await purgeProjects(d, token, uid, spend, purgeColl))) return false;   // P6b: subcollections first
  if (!(await purgeColl(token, `audit/${uid}/log`, spend))) return false;
  // the user's own invoices (issued). Paid invoices are financial records of the client too, but they live
  // under the issuer here, so they go with the issuer's account (the client keeps their own ledger row).
  if (d.runQuery) {
    for (;;) {
      if (!spend()) return false;
      const inv = await d.runQuery(token, { from: [{ collectionId: "invoices" }], where: { fieldFilter: { field: { fieldPath: "issuerUid" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 50 });
      if (!inv.length) break;
      for (const doc of inv) {
        const rel = doc.name.slice(d.DOC_ROOT.length + 1);
        if (!(await purgeColl(token, rel + "/payments", spend))) return false;
        if (!(await purgeColl(token, rel + "/proofs", spend))) return false;
        const tok = doc.fields && doc.fields.payLinkToken && doc.fields.payLinkToken.stringValue;
        await d.fsCommit(token, [{ delete: doc.name }, ...(tok ? [{ delete: d.DOC_ROOT + "/payLinks/" + tok }] : [])]);
      }
    }
  }
  if (!spend()) return false;
  await d.fsCommit(token, [{ delete: d.DOC_ROOT + `/pfm/${uid}` }, { delete: d.DOC_ROOT + `/audit/${uid}` }, { delete: d.DOC_ROOT + `/pfmDue/${uid}` }]);
  return true;
}

// =====================================================================================================
// P2: confirm suggested rows · budgets and alerts · recurring entries · categorisation rules · cron
// =====================================================================================================

async function opTxConfirm(x) {
  let out, sA = null;
  await commitAudited(x, async () => {
    const old = await loadTxForEdit(x);
    if (old.status !== "suggested") throw new C.PfmError("not_suggested");
    const s = await settingsOf(x), cats = await categoryMap(x);
    const input = { status: "booked" };
    for (const k of ["amount", "fxRate", "date", "categoryId", "note"]) if (x.p[k] !== undefined) input[k] = x.p[k];
    const nx = { ...(await buildTx(x, s, cats, input, old)), recurringId: old.recurringId, rev: old.rev + 1, createdAt: old.createdAt, updatedAt: now() };
    out = { id: old.id, ...nx }; sA = s;
    const writes = [{ update: { name: P(x, `pfm/${x.uid}/tx/${old.id}`), fields: fieldsOf(x, nx) }, currentDocument: { updateTime: old._updateTime } },
      ...rollupWrites(x, C.rollupDiff(old, nx))];
    if (!s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
    return { writes, audit: [{ action: "tx.confirm", ref: `tx/${old.id}`, after: auditView(nx) }], result: null };
  });
  const alerts = await checkAlerts(x, sA, [out]);
  return { tx: await present(x, out), alerts };
}

// ---------- budgets ----------

const TOTAL = "_total";
const DEFAULT_ALERTS = [5000, 8000, 10000];
async function opBudgetSet(x) {
  const p = x.p;
  let out;
  await commitAudited(x, async () => {
    const s = await settingsOf(x);
    const catId = p.categoryId;
    if (catId !== TOTAL) { const c = (await categoryMap(x)).get(catId); if (!c || c.kind !== "expense") throw new C.PfmError("bad_category"); }
    const limit = C.toMinor(p.limit, s.baseCurrency);
    if (limit <= 0) throw new C.PfmError("bad_amount");
    const alertsBp = p.alertsBp == null ? DEFAULT_ALERTS : p.alertsBp;
    if (!Array.isArray(alertsBp) || alertsBp.length > 5 || alertsBp.some((b) => !Number.isInteger(b) || b < 1000 || b > 20000)) throw new C.PfmError("bad_alerts");
    const old = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/budgets/${catId}`));
    const b = { categoryId: catId, limit, currency: s.baseCurrency, alertsBp: [...new Set(alertsBp)].sort((a, c) => a - c), createdAt: old?.createdAt || now(), updatedAt: now() };
    out = b;
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/budgets/${catId}`), fields: fieldsOf(x, b) } }],
      audit: [{ action: old ? "budget.update" : "budget.add", ref: `budgets/${catId}`, before: old ? { limit: old.limit } : undefined, after: { limit } }], result: null };
  });
  return { budget: out };
}
async function opBudgetDelete(x) {
  const id = x.p.categoryId === TOTAL ? TOTAL : segId(x.p.categoryId);
  await commitAudited(x, async () => {
    const old = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/budgets/${id}`));
    if (!old) return { result: null };
    return { writes: [{ delete: P(x, `pfm/${x.uid}/budgets/${id}`) }], audit: [{ action: "budget.delete", ref: `budgets/${id}`, before: { limit: old.limit } }], result: null };
  });
  return { categoryId: id, deleted: true };
}

// Status of every budget for one budget month. The current month uses today's position in the period;
// past months count as complete, future months as not started.
async function budgetStatuses(x, s, month) {
  const today = C.localDate(s.tz), cur = C.budgetMonth(today, s.monthStartDay);
  const per = C.budgetPeriod(month, s.monthStartDay);
  const elapsed = month < cur ? per.days : month > cur ? 0 : C.periodElapsed(per, today);
  const [bdocs, mdoc] = await Promise.all([x.d.fsList(x.token, `pfm/${x.uid}/budgets`), x.d.fsGet(x.token, `pfm/${x.uid}/months/${month}`)]);
  const m = js(x, mdoc) || {};
  return bdocs.map((dd) => js(x, dd)).filter((b) => b.currency === s.baseCurrency).map((b) => {
    const spent = b.categoryId === TOTAL ? m.expense || 0 : (m.cat && m.cat[b.categoryId] && m.cat[b.categoryId].e) || 0;
    const st = C.budgetStatus({ limit: b.limit, alertsBp: b.alertsBp, firedBp: [] }, spent, elapsed, per.days);
    return { categoryId: b.categoryId, alertsBp: b.alertsBp, ...st, state: st.usedBp >= 10000 ? "over" : st.usedBp >= 8000 ? "warn" : "ok",
      onPace: st.projected <= b.limit, period: per, elapsed };
  });
}
async function opBudgetList(x) {
  const s = await settingsOf(x);
  const month = x.p.month || C.budgetMonth(C.localDate(s.tz), s.monthStartDay);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new C.PfmError("bad_month");
  const list = await budgetStatuses(x, s, month);
  const order = (b) => (b.categoryId === TOTAL ? -1 : 0);
  return { month, currency: s.baseCurrency, budgets: list.sort((a, b) => order(a) - order(b) || b.usedBp - a.usedBp) };
}

// ---------- alerts ----------

// After rows change, check the budgets they touch in the CURRENT budget month only (backdated entries in old
// months never alert). Each alert is a document whose id is month+category+threshold, created with
// exists:false, so it fires at most once even when two writes race; only the creator sends the push.
async function checkAlerts(x, s, rows) {
  try {
    const today = C.localDate(s.tz), month = C.budgetMonth(today, s.monthStartDay);
    const touched = new Set();
    for (const r of rows) if (r && r.kind === "expense" && r.month === month) touched.add(r.categoryId);
    if (!touched.size) return [];
    touched.add(TOTAL);
    const statuses = (await budgetStatuses(x, s, month)).filter((b) => touched.has(b.categoryId));
    const cats = await categoryMap(x);
    const fired = [];
    for (const b of statuses) {
      const fresh = [];
      for (const a of b.alerts) {
        const key = a.kind === "pace" ? "pace" : String(a.bp);
        const doc = { month, categoryId: b.categoryId, kind: a.kind, bp: a.bp, spent: b.spent, limit: b.limit, projected: b.projected, at: now(), read: false };
        try {
          await x.d.fsCommit(x.token, [{ update: { name: P(x, `pfm/${x.uid}/alerts/${month}_${b.categoryId}_${key}`), fields: fieldsOf(x, doc) }, currentDocument: { exists: false } }]);
          fresh.push({ id: `${month}_${b.categoryId}_${key}`, ...doc });
        } catch (e) { if (!isConflict(e)) throw e; }   // already fired this month
      }
      if (!fresh.length) continue;
      fired.push(...fresh);
      // one push per budget: the most serious new alert (over limit > heading over > highest threshold)
      const top = fresh.sort((a, c) => sev(c) - sev(a))[0];
      if (x.d.push) {
        const [title, body] = alertText(s, top, cats.get(b.categoryId));
        await x.d.push(x.token, x.uid, title, body).catch(() => 0);
      }
    }
    return fired;
  } catch (e) { return []; }   // alerts never fail the write that triggered them
}
const sev = (a) => (a.kind === "pace" ? 9000 : a.bp);
function moneyText(minor, cur) {
  const e = C.currencyExp(cur);
  return new Intl.NumberFormat("en", { minimumFractionDigits: e, maximumFractionDigits: e }).format(minor / 10 ** e) + " " + cur;
}
export function alertText(s, a, cat) {
  const ar = s.locale !== "en", cur = s.baseCurrency;
  const name = a.categoryId === TOTAL ? (ar ? "كلّ المصروفات" : "All spending") : cat ? (ar ? cat.nameAr || cat.name : cat.name) : a.categoryId;
  const pct = Math.round((a.spent * 100) / a.limit);
  if (a.kind === "pace")
    return ar ? [`${name}: الإنفاق أسرع من الميزانيّة`, `بهذه الوتيرة ستصل إلى ${moneyText(a.projected, cur)} من ${moneyText(a.limit, cur)} بنهاية الشهر`]
      : [`${name}: spending faster than budgeted`, `At this pace you'll reach ${moneyText(a.projected, cur)} of ${moneyText(a.limit, cur)} by month end`];
  if (a.bp >= 10000)
    return ar ? [`تجاوزت ميزانيّة ${name}`, `أنفقت ${moneyText(a.spent, cur)} من ${moneyText(a.limit, cur)} (${pct}%)`]
      : [`Over budget: ${name}`, `${moneyText(a.spent, cur)} spent of ${moneyText(a.limit, cur)} (${pct}%)`];
  return ar ? [`${name}: استُهلك ${pct}% من الميزانيّة`, `بقي ${moneyText(a.limit - a.spent, cur)}`]
    : [`${name}: ${pct}% of budget used`, `${moneyText(a.limit - a.spent, cur)} left`];
}
async function unreadAlerts(x, month) {
  const docs = await x.d.fsQuerySub(x.token, `pfm/${x.uid}`, "alerts", [["month", "EQUAL", month]], 100);
  return docs.map((dd) => strip(js(x, dd))).filter((a) => !a.read).sort((a, b) => (a.at < b.at ? 1 : -1));
}
async function opAlertsList(x) {
  const s = await settingsOf(x);
  const month = x.p.month || C.budgetMonth(C.localDate(s.tz), s.monthStartDay);
  const docs = await x.d.fsQuerySub(x.token, `pfm/${x.uid}`, "alerts", [["month", "EQUAL", month]], 100);
  return { month, alerts: docs.map((dd) => strip(js(x, dd))).sort((a, b) => (a.at < b.at ? 1 : -1)) };
}
async function opAlertsRead(x) {
  const ids = Array.isArray(x.p.ids) ? x.p.ids.slice(0, 50).map(segId) : [];
  if (!ids.length) return { read: 0 };
  await x.d.fsCommit(x.token, ids.map((id) => ({ update: { name: P(x, `pfm/${x.uid}/alerts/${id}`), fields: fieldsOf(x, { read: true }) },
    updateMask: { fieldPaths: ["read"] }, currentDocument: { exists: true } }))).catch((e) => { if (!/NOT_FOUND/.test(String(e.message))) throw e; });
  return { read: ids.length };
}

// ---------- receipt import: the user's own accounts and confirmed names (IMPORT-DESIGN.md §4.7) ----------
// One sealed document: { accounts: ["1111 2222 3333 0001", …], names: { "1111222233330001": "Name", … } }.
// Account numbers and names are personal, so the whole thing is encrypted like notes.

const ACCT_RE = /^[0-9 ]{6,40}$/;
async function opImportPrefsGet(x) {
  const d = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/import/prefs`));
  if (!d || !d.data) return { accounts: [], names: {} };
  const v = JSON.parse(await C.openField(d.data, x.uid, keys(x)));
  return { accounts: v.accounts || [], names: v.names || {} };
}
async function opImportPrefsSet(x) {
  const { accounts = [], names = {} } = x.p;
  if (!Array.isArray(accounts) || accounts.length > 20 || !accounts.every((a) => typeof a === "string" && ACCT_RE.test(a))) throw new C.PfmError("bad_account");
  const ents = Object.entries(names && typeof names === "object" ? names : {});
  if (ents.length > 1000 || !ents.every(([k, v]) => /^[0-9]{6,34}$/.test(k) && typeof v === "string" && v.trim() && v.length <= 80)) throw new C.PfmError("bad_name");
  const data = await seal(x, JSON.stringify({ accounts: [...new Set(accounts.map((a) => a.trim()))], names: Object.fromEntries(ents.map(([k, v]) => [k, v.trim()])) }));
  await x.d.fsCommit(x.token, [{ update: { name: P(x, `pfm/${x.uid}/import/prefs`), fields: fieldsOf(x, { data, updatedAt: now() }) } }]);
  return { ok: true };
}

// ---------- categorisation rules ----------

async function rulesOf(x) {
  const docs = await x.d.fsList(x.token, `pfm/${x.uid}/rules`);
  const out = [];
  for (const dd of docs) { const r = js(x, dd); r.contains = await C.openField(r.contains, x.uid, keys(x)).catch(() => ""); out.push(r); }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}
async function opRuleUpsert(x) {
  const p = x.p;
  const contains = txt(p.contains, 60, "contains");
  if (!contains || C.normText(contains).length < 2) throw new C.PfmError("bad_contains");
  const kind = p.kind == null ? null : p.kind;
  if (kind !== null && kind !== "income" && kind !== "expense") throw new C.PfmError("bad_kind");
  let out;
  await commitAudited(x, async () => {
    const cats = await categoryMap(x), c = cats.get(p.categoryId);
    if (!c || (kind && c.kind !== kind)) throw new C.PfmError("bad_category");
    const rules = await rulesOf(x);
    // the same text again replaces the old rule instead of adding a duplicate
    const same = rules.find((r) => (p.id ? r.id === p.id : C.normText(r.contains) === C.normText(contains) && (r.kind || null) === kind));
    if (!same && rules.length >= 200) throw new C.PfmError("too_many_rules");
    const id = same ? same.id : "r_" + rid(10);
    const doc = { contains: await seal(x, contains), categoryId: p.categoryId, kind, createdAt: same?.createdAt || now(), updatedAt: now() };
    out = { id, contains, categoryId: p.categoryId, kind };
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/rules/${id}`), fields: fieldsOf(x, doc) } }],
      audit: [{ action: same ? "rule.update" : "rule.add", ref: `rules/${id}`, after: { categoryId: p.categoryId, kind } }], result: null };
  });
  return { rule: out };
}
async function opRuleDelete(x) {
  const id = segId(x.p.id);
  await commitAudited(x, async () => {
    if (!(await x.d.fsGet(x.token, `pfm/${x.uid}/rules/${id}`))) return { result: null };
    return { writes: [{ delete: P(x, `pfm/${x.uid}/rules/${id}`) }], audit: [{ action: "rule.delete", ref: `rules/${id}` }], result: null };
  });
  return { id, deleted: true };
}

// ---------- recurring entries ----------

async function recurringOf(x) {
  return (await x.d.fsList(x.token, `pfm/${x.uid}/recurring`)).map((dd) => js(x, dd)).sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
}
const addDay = (d, n = 1) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

async function opRecurringUpsert(x) {
  const p = x.p;
  let out;
  await commitAudited(x, async () => {
    const s = await settingsOf(x), cats = await categoryMap(x);
    const old = p.id ? js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/recurring/${segId(p.id)}`)) : null;
    if (p.id && !old) throw new C.PfmError("not_found", "recurring");
    const rule = p.rule ? C.checkRule(p.rule) : old?.rule;
    if (!rule) throw new C.PfmError("bad_rule");
    // Validate amount, currency, rate, category and texts exactly like a ledger row.
    const startDate = p.startDate || old?.startDate || C.localDate(s.tz);
    const input = {};
    for (const k of ["kind", "amount", "currency", "fxRate", "categoryId", "note", "counterparty"]) if (p[k] !== undefined) input[k] = p[k];
    const t = await buildTx(x, s, cats, { ...input, date: startDate }, old ? { ...old, date: startDate } : null);
    let nextDate = old?.nextDate;
    if (!old || p.rule || p.startDate) nextDate = C.firstOccurrence(rule, p.after ? addDay(startDate) : startDate);
    const endDate = p.endDate === undefined ? old?.endDate ?? null : p.endDate;
    if (endDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new C.PfmError("bad_date");
    const mode = p.mode === "auto" ? "auto" : p.mode === "suggest" ? "suggest" : old?.mode || "suggest";
    const id = old?.id || "rc_" + rid(10);
    const doc = { kind: t.kind, amount: t.amount, currency: t.currency, fxRate: t.currency === s.baseCurrency ? "1" : t.fxRate, categoryId: t.categoryId,
      note: t.note, counterparty: t.counterparty, rule, startDate, nextDate, endDate, mode, paused: old?.paused || false,
      lastDate: old?.lastDate || null, createdAt: old?.createdAt || now(), updatedAt: now() };
    out = { id, ...doc };
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/recurring/${id}`), fields: fieldsOf(x, doc) }, currentDocument: old ? { updateTime: old._updateTime } : { exists: false } }],
      audit: [{ action: old ? "recurring.update" : "recurring.add", ref: `recurring/${id}`, after: { rule, amount: doc.amount, currency: doc.currency, categoryId: doc.categoryId, nextDate, mode } }],
      result: null };
  });
  const s = await settingsOf(x);
  await materialise(x, s, C.localDate(s.tz));     // a start date in the past produces its entries now
  await updateDue(x, s);
  return { recurring: await present(x, out) };
}
async function opRecurringPause(x) {
  const paused = x.p.paused !== false;
  await commitAudited(x, async () => {
    const r = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/recurring/${segId(x.p.id)}`));
    if (!r) throw new C.PfmError("not_found", "recurring");
    if (r.paused === paused) return { result: null };
    const s = await settingsOf(x);
    // Resuming skips what was missed while paused: the next date is the first one from today.
    const next = paused ? r.nextDate : C.firstOccurrence(r.rule, C.localDate(s.tz));
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/recurring/${r.id}`), fields: fieldsOf(x, { paused, nextDate: next, updatedAt: now() }) },
      updateMask: { fieldPaths: ["paused", "nextDate", "updatedAt"] }, currentDocument: { updateTime: r._updateTime } }],
      audit: [{ action: paused ? "recurring.pause" : "recurring.resume", ref: `recurring/${r.id}` }], result: null };
  });
  await updateDue(x, await settingsOf(x));
  return { id: x.p.id, paused };
}
async function opRecurringDelete(x) {
  const id = segId(x.p.id);
  await commitAudited(x, async () => {
    if (!(await x.d.fsGet(x.token, `pfm/${x.uid}/recurring/${id}`))) return { result: null };
    return { writes: [{ delete: P(x, `pfm/${x.uid}/recurring/${id}`) }], audit: [{ action: "recurring.delete", ref: `recurring/${id}` }], result: null };
  });
  await updateDue(x, await settingsOf(x));
  return { id, deleted: true };
}

// Creates the rows of every recurring entry due by `today`: "suggested" (default, outside the totals until
// confirmed) or "booked" (mode auto). Row ids are fixed per occurrence, so a repeat run creates nothing new.
async function materialise(x, s, today) {
  const list = (await recurringOf(x)).filter((r) => !r.paused && r.nextDate && r.nextDate <= today);
  let created = 0;
  const booked = [];
  for (const r0 of list) {
    await commitAudited(x, async () => {
      const r = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/recurring/${r0.id}`));
      if (!r || r.paused || !r.nextDate || r.nextDate > today) return { result: null };
      const due = C.dueOccurrences(r.rule, r.nextDate, today, r.endDate);
      const writes = [], auto = r.mode === "auto";
      for (const date of due.dates) {
        const id = `r_${r.id}_${date.replace(/-/g, "")}`;
        if (await x.d.fsGet(x.token, `pfm/${x.uid}/tx/${id}`)) continue;
        const baseAmount = r.currency === s.baseCurrency ? r.amount : r.fxRate ? C.convert(r.amount, r.currency, s.baseCurrency, r.fxRate) : null;
        const tx = { kind: r.kind, amount: r.amount, currency: r.currency, baseAmount, fxRate: r.currency === s.baseCurrency ? "1" : r.fxRate || null,
          fxSource: r.currency === s.baseCurrency ? "same" : r.fxRate ? "manual" : "pending", categoryId: r.categoryId, date,
          month: C.budgetMonth(date, s.monthStartDay), note: r.note || null, counterparty: r.counterparty || null, source: "recurring", recurringId: r.id,
          status: auto ? "booked" : "suggested", deleted: false, autoCategorized: false, rev: 1, createdAt: now(), updatedAt: now() };
        writes.push({ update: { name: P(x, `pfm/${x.uid}/tx/${id}`), fields: fieldsOf(x, tx) }, currentDocument: { exists: false } });
        if (auto) { writes.push(...rollupWrites(x, C.rollupDiff(null, tx))); booked.push(tx); }
      }
      writes.push({ update: { name: P(x, `pfm/${x.uid}/recurring/${r.id}`), fields: fieldsOf(x, { nextDate: due.next, paused: due.ended || false, lastDate: due.dates.at(-1) || r.lastDate || null, updatedAt: now() }) },
        updateMask: { fieldPaths: ["nextDate", "paused", "lastDate", "updatedAt"] }, currentDocument: { updateTime: r._updateTime } });
      if (auto && booked.length && !s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
      created += writes.filter((w) => w.currentDocument && w.currentDocument.exists === false).length;
      return { writes, audit: [{ action: "recurring.run", ref: `recurring/${r.id}`, after: { dates: due.dates, mode: r.mode } }], result: null };
    });
  }
  if (list.length) await updateDue(x, s);
  if (booked.length) await checkAlerts(x, s, booked);
  return { created, booked: booked.length };
}

// pfmDue/{uid}.next = the earliest next date of the user's active recurring entries, so the cron can find
// due users with one range query on a top-level collection (single-field index, no setup needed).
async function updateDue(x, s) {
  const next = (await recurringOf(x)).filter((r) => !r.paused && r.nextDate && (!r.endDate || r.nextDate <= r.endDate)).map((r) => r.nextDate).sort()[0];
  await x.d.fsCommit(x.token, [next ? { update: { name: P(x, `pfmDue/${x.uid}`), fields: fieldsOf(x, { next, tz: s.tz, updatedAt: now() }) } } : { delete: P(x, `pfmDue/${x.uid}`) }]);
}

// Cron: users with something due → create the rows, then one reminder each.
// The query bound is "today" in the zone that is furthest ahead, so every user whose local date has
// reached their next date is included; each one is then checked against their own time zone.
export async function pfmCron(env, d, max = 20) {
  if (!env.PFM_KEK_v1 || !d.runQuery) return { users: 0 };
  const token = await d.getToken(env);
  const maxToday = C.localDate("Pacific/Kiritimati");
  const docs = await d.runQuery(token, { from: [{ collectionId: "pfmDue" }],
    where: { fieldFilter: { field: { fieldPath: "next" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: maxToday } } }, limit: max });
  let users = 0, rows = 0;
  for (const doc of docs) {
    const uid = doc.name.split("/").pop();
    const x = { uid, env, d, token, p: {} };
    try {
      const s = await settingsOf(x, false);
      if (!s) { await d.fsCommit(token, [{ delete: doc.name }]); continue; }
      const today = C.localDate(s.tz);
      const r = await materialise(x, s, today);
      const suggested = r.created - r.booked;
      if (suggested > 0 && d.push) {
        const ar = s.locale !== "en";
        await d.push(token, uid, ar ? "حركات متكرّرة بانتظار التأكيد" : "Recurring entries to confirm",
          ar ? `${suggested} ${suggested === 1 ? "حركة مستحقّة" : "حركات مستحقّة"} — افتح المحاسب الشخصيّ لتأكيدها` : `${suggested} ${suggested === 1 ? "entry is" : "entries are"} due — open the Personal accountant to confirm`).catch(() => 0);
      }
      users++; rows += r.created;
    } catch (e) { /* one user's failure never stops the others */ }
  }
  const overdue = await overdueSweep(env, d, token, max).catch(() => 0);
  return { users, rows, ...(overdue ? { overdue } : {}) };
}

// =====================================================================================================
// P3: business settings · logo · receiving accounts · invoices (draft → sent → paid/overdue/cancelled)
// =====================================================================================================

const BIZ_SEALED = ["address", "taxId"];
async function bizOf(x, s) {
  const b = { name: "", contact: "", address: "", taxId: "", taxRegistered: false, taxLabel: "", taxRates: [], defaultTaxRateId: null,
    invoicePrefix: "INV", defaultDueDays: 14, defaultAllowPartial: true, defaultInvoiceCurrency: s.baseCurrency, defaultPayoutAccountIds: [], lang: s.locale || "ar", ...(s.biz || {}) };
  for (const k of BIZ_SEALED) b[k] = b[k] ? await C.openField(b[k], x.uid, keys(x)).catch(() => "") : "";
  return b;
}
async function opBizGet(x) {
  const s = await settingsOf(x);
  const [biz, accounts, logo] = await Promise.all([bizOf(x, s), accountsOf(x, true), x.d.fsGet(x.token, `pfm/${x.uid}/files/logo`)]);
  return { biz, accounts, logo: logo ? js(x, logo).data : null, nextNumber: nextNumberPreview(s, biz) };
}
function nextNumberPreview(s, biz) {
  const today = C.localDate(s.tz), y = today.slice(0, 4);
  return C.invoiceNumber(biz.invoicePrefix || "INV", today, ((s.invoiceSeq || {})[y] || 0) + 1).number;
}
async function opBizSet(x) {
  const p = x.p;
  await commitAudited(x, async () => {
    const s = await settingsOf(x);
    const cur = s.biz || {};
    const next = { ...cur };
    const str = (k, max) => { if (p[k] !== undefined) next[k] = txt(p[k], max, k) || ""; };
    str("name", 80); str("contact", 120); str("taxLabel", 24);
    for (const k of BIZ_SEALED) if (p[k] !== undefined) { const v = txt(p[k], k === "address" ? 200 : 40, k); next[k] = v ? await seal(x, v) : ""; }
    if (p.taxRegistered !== undefined) next.taxRegistered = !!p.taxRegistered;
    if (p.taxRates !== undefined) {
      if (!Array.isArray(p.taxRates) || p.taxRates.length > 10) throw new C.PfmError("bad_tax");
      next.taxRates = p.taxRates.map((r) => ({ id: /^[a-z0-9_]{1,20}$/.test(r.id || "") ? r.id : "t" + rid(6), label: txt(r.label, 24, "label") || "", rate: C.rateText(C.toRate(r.rate)) }));
    }
    if (p.defaultTaxRateId !== undefined) next.defaultTaxRateId = p.defaultTaxRateId && (next.taxRates || []).some((r) => r.id === p.defaultTaxRateId) ? p.defaultTaxRateId : null;
    if (p.invoicePrefix !== undefined) { C.invoiceNumber(p.invoicePrefix, "2000-01-01", 1); next.invoicePrefix = p.invoicePrefix; }
    if (p.defaultDueDays !== undefined) { if (!Number.isInteger(p.defaultDueDays) || p.defaultDueDays < 0 || p.defaultDueDays > 365) throw new C.PfmError("bad_due_days"); next.defaultDueDays = p.defaultDueDays; }
    if (p.defaultAllowPartial !== undefined) next.defaultAllowPartial = !!p.defaultAllowPartial;
    if (p.defaultInvoiceCurrency !== undefined) { C.currencyExp(p.defaultInvoiceCurrency); next.defaultInvoiceCurrency = p.defaultInvoiceCurrency; }
    if (p.defaultPayoutAccountIds !== undefined) next.defaultPayoutAccountIds = (Array.isArray(p.defaultPayoutAccountIds) ? p.defaultPayoutAccountIds : []).slice(0, 10).map(segId);
    if (p.lang !== undefined) next.lang = p.lang === "en" ? "en" : "ar";
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { biz: next, updatedAt: now() }) }, updateMask: { fieldPaths: ["biz", "updatedAt"] }, currentDocument: { updateTime: s._updateTime } }],
      audit: [{ action: "biz.update", ref: `pfm/${x.uid}`, after: { fields: Object.keys(p).sort() } }], result: null };
  });
  return opBizGet(x);
}

// Logo: a data: URI the phone already shrank (≤ 512 px WebP/PNG/JPEG). The bytes are checked, not the name; SVG is refused.
async function opLogoSet(x) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x.p.data || ""));
  if (!m) throw new C.PfmError("bad_logo", "type");
  const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
  if (bytes.length > 150 * 1024) throw new C.PfmError("bad_logo", "too_big");
  const type = C.sniffLogo(bytes);
  if (type !== m[1]) throw new C.PfmError("bad_logo", "type");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  await commitAudited(x, async () => {
    await settingsOf(x);
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/files/logo`), fields: fieldsOf(x, { data: `data:${type};base64,${m[3]}`, type, sha, size: bytes.length, updatedAt: now() }) } }],
      audit: [{ action: "logo.set", ref: "files/logo", after: { sha, size: bytes.length } }], result: null };
  });
  return { sha, size: bytes.length };
}
async function opLogoDelete(x) {
  await commitAudited(x, async () => ({ writes: [{ delete: P(x, `pfm/${x.uid}/files/logo`) }], audit: [{ action: "logo.delete", ref: "files/logo" }], result: null }));
  return { deleted: true };
}

// ---------- receiving accounts ----------

async function accountsOf(x, masked) {
  const out = [];
  for (const dd of await x.d.fsList(x.token, `pfm/${x.uid}/payoutAccounts`)) {
    const a = strip(js(x, dd));
    const n = a.number ? await C.openField(a.number, x.uid, keys(x)).catch(() => "") : "";
    out.push({ ...a, number: masked ? C.maskNumber(n) : n });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}
async function opAccountUpsert(x) {
  const p = x.p;
  const v = C.validatePayoutAccount(p);
  let numberChanged = false;
  if (v.type === "sawa_wallet") throw new C.PfmError("bad_account", "type");   // the wallet account comes with the wallet ledger (deferred)
  let out;
  await commitAudited(x, async () => {
    const old = p.id ? js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/payoutAccounts/${segId(p.id)}`)) : null;
    if (p.id && !old) throw new C.PfmError("not_found", "account");
    if (!old && (await x.d.fsList(x.token, `pfm/${x.uid}/payoutAccounts`)).length >= 10) throw new C.PfmError("too_many_accounts");
    const id = old?.id || "pa_" + rid(10);
    const doc = { ...v, number: v.number ? await seal(x, v.number) : null, numberLast4: v.number ? v.number.slice(-4) : null, archived: false, createdAt: old?.createdAt || now(), updatedAt: now() };
    for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
    out = { id, ...doc, number: C.maskNumber(v.number) };
    // A changed number is a classic way to redirect payments: it is audited and pushed to the owner.
    numberChanged = !!old && old.numberLast4 !== doc.numberLast4;
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/payoutAccounts/${id}`), fields: fieldsOf(x, doc) }, currentDocument: old ? { updateTime: old._updateTime } : { exists: false } }],
      audit: [{ action: old ? "account.update" : "account.add", ref: `payoutAccounts/${id}`, after: { type: v.type, currency: v.currency, last4: doc.numberLast4, label: v.label } }], result: null };
  });
  if (numberChanged && x.d.push) {
    const s = await settingsOf(x), ar = s.locale !== "en";
    await x.d.push(x.token, x.uid, ar ? "تغيّرت بيانات حساب استلام" : "Receiving account changed",
      ar ? `«${out.label}» صار ينتهي بـ ${out.numberLast4}. إن لم تكن أنت، غيّره فوراً.` : `“${out.label}” now ends in ${out.numberLast4}. If this wasn't you, change it now.`).catch(() => 0);
  }
  return { account: out };
}
async function opAccountArchive(x) {
  const archived = x.p.archived !== false;
  await commitAudited(x, async () => {
    const a = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/payoutAccounts/${segId(x.p.id)}`));
    if (!a) throw new C.PfmError("not_found", "account");
    return { writes: [{ update: { name: P(x, `pfm/${x.uid}/payoutAccounts/${a.id}`), fields: fieldsOf(x, { archived, updatedAt: now() }) }, updateMask: { fieldPaths: ["archived", "updatedAt"] }, currentDocument: { updateTime: a._updateTime } }],
      audit: [{ action: archived ? "account.archive" : "account.restore", ref: `payoutAccounts/${a.id}` }], result: null };
  });
  return { id: x.p.id, archived };
}

// ---------- invoices ----------

const INV_ID = /^iv_[a-z0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDaysTo = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Normalises the editor's input into stored items + options, applying the issuer's tax setting.
function invoiceInputs(biz, p, currency) {
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 200) throw new C.PfmError("bad_items");
  const items = p.items.map((it, i) => {
    const description = txt(it.description, 200, "description");
    if (!description) throw new C.PfmError("bad_items", "line " + (i + 1) + ": description");
    const unitPrice = typeof it.unitPrice === "number" ? it.unitPrice : C.toMinor(it.unitPrice ?? "", currency);
    const out = { description, qty: String(it.qty ?? "1"), unitPrice };
    if (it.discount && it.discount.type === "pct" && it.discount.rate) out.discount = { type: "pct", rate: C.rateText(C.toRate(it.discount.rate)) };
    if (it.discount && it.discount.type === "amt" && (it.discount.amount || it.discount.minor))   // editor sends text, a stored draft has minor units
      out.discount = { type: "amt", minor: Number.isSafeInteger(it.discount.minor) ? it.discount.minor : C.toMinor(it.discount.amount, currency) };
    if (it.taxRate != null && it.taxRate !== "") out.taxRate = String(it.taxRate);
    if (it.taxRateId) out.taxRateId = it.taxRateId;
    return out;
  });
  const pol = C.applyTaxPolicy({ taxRegistered: biz.taxRegistered, taxRates: biz.taxRates, taxLabel: biz.taxLabel }, items, { taxInclusive: !!p.taxInclusive, taxLabel: p.taxLabel });
  let invoiceDiscount = null;
  if (p.invoiceDiscount && p.invoiceDiscount.type === "pct" && p.invoiceDiscount.rate) invoiceDiscount = { type: "pct", rate: C.rateText(C.toRate(p.invoiceDiscount.rate)) };
  if (p.invoiceDiscount && p.invoiceDiscount.type === "amt" && (p.invoiceDiscount.amount || p.invoiceDiscount.minor))
    invoiceDiscount = { type: "amt", minor: Number.isSafeInteger(p.invoiceDiscount.minor) ? p.invoiceDiscount.minor : C.toMinor(p.invoiceDiscount.amount, currency) };
  return { items: pol.items, taxInclusive: pol.taxInclusive, taxLabel: pol.taxLabel, invoiceDiscount };
}
const totalsOf = (inv) => C.computeInvoice(inv.items, { currency: inv.currency, invoiceDiscount: inv.invoiceDiscount, taxInclusive: inv.taxInclusive, amountPaid: inv.amountPaid || 0 });

async function opInvPreview(x) {
  const s = await settingsOf(x), biz = await bizOf(x, s);
  const currency = x.p.currency || biz.defaultInvoiceCurrency;
  C.currencyExp(currency);
  const v = invoiceInputs(biz, x.p, currency);
  return { totals: C.computeInvoice(v.items, { currency, invoiceDiscount: v.invoiceDiscount, taxInclusive: v.taxInclusive }), taxLabel: v.taxLabel };
}

async function loadInvoice(x, id, { draftOnly } = {}) {
  if (!INV_ID.test(id || "")) throw new C.PfmError("bad_id");
  const inv = js(x, await x.d.fsGet(x.token, `invoices/${id}`));
  if (!inv || inv.issuerUid !== x.uid) throw new C.PfmError("not_found", "invoice");   // another user's invoice looks like none
  if (draftOnly && inv.status !== "draft") throw new C.PfmError("not_draft", "a sent invoice can't be edited; cancel it and issue a new one");
  return inv;
}

// create (no id) or update a draft
async function opInvSave(x) {
  const p = x.p;
  let out;
  await commitAudited(x, async () => {
    const s = await settingsOf(x), biz = await bizOf(x, s);
    const old = p.id ? await loadInvoice(x, p.id, { draftOnly: true }) : null;
    if (old && p.rev !== old.rev) throw new C.PfmError("stale", "reload and try again");
    const currency = p.currency || old?.currency || biz.defaultInvoiceCurrency;
    C.currencyExp(currency);
    const v = invoiceInputs(biz, p.items ? p : { ...old, ...p, items: old.items }, currency);
    const today = C.localDate(s.tz);
    const issueDate = p.issueDate || old?.issueDate || today;
    const dueDate = p.dueDate || old?.dueDate || addDaysTo(issueDate, biz.defaultDueDays);
    if (!DATE.test(issueDate) || !DATE.test(dueDate) || dueDate < issueDate) throw new C.PfmError("bad_date");
    const c = p.client || {};
    const cname = txt(c.name ?? (old ? null : ""), 120, "client");
    if (!old && !cname) throw new C.PfmError("bad_client", "client name");
    const accounts = await accountsOf(x, true);
    const ids = (p.payoutAccountIds ?? old?.payoutAccountIds ?? biz.defaultPayoutAccountIds ?? []).filter((id) => accounts.some((a) => a.id === id && !a.archived));
    const totals = C.computeInvoice(v.items, { currency, invoiceDiscount: v.invoiceDiscount, taxInclusive: v.taxInclusive });
    const id = old?.id || "iv_" + rid(12);
    const doc = { issuerUid: x.uid, status: "draft", number: null, lang: p.lang || old?.lang || biz.lang, currency, issueDate, dueDate,
      client: { name: cname != null ? await seal(x, cname) : old.client.name, contact: c.contact !== undefined ? await seal(x, txt(c.contact, 120, "contact") || "") : old?.client?.contact || "",
        taxId: c.taxId !== undefined ? await seal(x, txt(c.taxId, 40, "taxId") || "") : old?.client?.taxId || "" },
      items: v.items, invoiceDiscount: v.invoiceDiscount, taxInclusive: v.taxInclusive, taxLabel: v.taxLabel,
      allowPartial: p.allowPartial ?? old?.allowPartial ?? biz.defaultAllowPartial, payoutAccountIds: ids,
      notes: p.notes !== undefined ? await seal(x, txt(p.notes, 1000, "notes") || "") : old?.notes || "",
      totals: { ...totals, lines: undefined }, amountPaid: 0, rev: (old?.rev || 0) + 1, createdAt: old?.createdAt || now(), updatedAt: now() };
    delete doc.totals.lines;
    out = { id, ...doc };
    return { writes: [{ update: { name: P(x, `invoices/${id}`), fields: fieldsOf(x, doc) }, currentDocument: old ? { updateTime: old._updateTime } : { exists: false } }],
      audit: [{ action: old ? "invoice.update" : "invoice.create", ref: `invoices/${id}`, after: { total: totals.total, currency, items: v.items.length } }], result: null };
  });
  return { invoice: await presentInvoice(x, out) };
}

async function opInvDelete(x) {
  await commitAudited(x, async () => {
    const inv = await loadInvoice(x, x.p.id, { draftOnly: true });
    return { writes: [{ delete: P(x, `invoices/${inv.id}`) }], audit: [{ action: "invoice.delete", ref: `invoices/${inv.id}` }], result: null };
  });
  return { id: x.p.id, deleted: true };
}

async function presentInvoice(x, inv, withPayments) {
  const o = strip(inv);
  const open = (v) => (v ? C.openField(v, x.uid, keys(x)).catch(() => "") : "");
  o.client = { name: await open(inv.client?.name), contact: await open(inv.client?.contact), taxId: await open(inv.client?.taxId) };
  o.notes = await open(inv.notes);
  if (o.issuer) o.issuer = { ...o.issuer, address: await open(o.issuer.address), taxId: await open(o.issuer.taxId) };
  if (Array.isArray(o.payoutAccounts)) o.payoutAccounts = await Promise.all(o.payoutAccounts.map(async (a) => ({ ...a, number: await open(a.number) })));
  o.totals = totalsOf(inv);
  if (withPayments) o.payments = await Promise.all((await x.d.fsList(x.token, `invoices/${inv.id}/payments`)).map((dd) => strip(js(x, dd))).sort((a, b) => (a.at < b.at ? -1 : 1))
    .map(async (p) => ({ ...p, reference: await open(p.reference), payer: p.payer ? { name: await open(p.payer.name), phone: await open(p.payer.phone) } : null, note: await open(p.note) })));
  return o;
}
async function opInvGet(x) {
  return { invoice: await presentInvoice(x, await loadInvoice(x, x.p.id), true) };
}
async function opInvList(x) {
  const docs = await x.d.runQuery(x.token, { from: [{ collectionId: "invoices" }],
    where: { fieldFilter: { field: { fieldPath: "issuerUid" }, op: "EQUAL", value: { stringValue: x.uid } } }, limit: 500 });
  let list = docs.map((dd) => js(x, dd));
  if (x.p.status) list = list.filter((i) => i.status === x.p.status);
  list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const items = await Promise.all(list.map(async (i) => ({ id: i.id, status: i.status, number: i.number, currency: i.currency, issueDate: i.issueDate, dueDate: i.dueDate,
    clientName: i.client?.name ? await C.openField(i.client.name, x.uid, keys(x)).catch(() => "") : "", total: i.totals.total, amountPaid: i.amountPaid || 0,
    amountDue: i.totals.total - (i.amountPaid || 0), openClaims: i.openClaims || 0, updatedAt: i.updatedAt })));
  const sum = (st) => items.filter((i) => st.includes(i.status));
  return { items, outstanding: byCurrency(sum(["sent", "overdue"]), "amountDue"), overdue: sum(["overdue"]).length, claims: items.reduce((a, i) => a + i.openClaims, 0) };
}
function byCurrency(list, field) { const m = {}; for (const i of list) m[i.currency] = (m[i.currency] || 0) + i[field]; return Object.entries(m).map(([currency, amount]) => ({ currency, amount })); }

// draft → sent: number (yearly sequence), snapshots, pay-link token. One commit.
async function opInvSend(x) {
  let out;
  await commitAudited(x, async () => {
    const inv = await loadInvoice(x, x.p.id, { draftOnly: true });
    C.assertTransition(inv.status, "sent");
    const s = await settingsOf(x), biz = await bizOf(x, s);
    if (!biz.name) throw new C.PfmError("business_name_missing");
    const issueDate = inv.issueDate, year = issueDate.slice(0, 4);
    const seq = ((s.invoiceSeq || {})[year] || 0) + 1;
    const { number } = C.invoiceNumber(biz.invoicePrefix || "INV", issueDate, seq);
    const accounts = await accountsOf(x, false);
    const chosen = C.accountsForInvoice(accounts, inv.payoutAccountIds || [], inv.currency);
    const token = rid(22);
    const sentAt = now();
    const issuer = { name: biz.name, contact: biz.contact, address: biz.address ? await seal(x, biz.address) : "", taxId: biz.taxId ? await seal(x, biz.taxId) : "" };
    const payoutAccounts = await Promise.all(chosen.map(async (a) => ({ id: a.id, type: a.type, currency: a.currency, label: a.label, holderName: a.holderName || null,
      bankName: a.bankName || null, provider: a.provider || null, branch: a.branch || null, details: a.details || null, number: a.number ? await seal(x, a.number) : null })));
    const patch = { status: "sent", number, issuer, payoutAccounts, payLinkToken: token, sentAt, rev: inv.rev + 1, updatedAt: sentAt };
    out = { ...inv, ...patch };
    return {
      writes: [
        { update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { invoiceSeq: { ...(s.invoiceSeq || {}), [year]: seq } }) }, updateMask: { fieldPaths: ["invoiceSeq"] }, currentDocument: { updateTime: s._updateTime } },
        { update: { name: P(x, `pfm/${x.uid}/invoiceNumbers/${number}`), fields: fieldsOf(x, { invoiceId: inv.id, at: sentAt }) }, currentDocument: { exists: false } },
        { update: { name: P(x, `invoices/${inv.id}`), fields: fieldsOf(x, patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime: inv._updateTime } },
        { update: { name: P(x, `payLinks/${token}`), fields: fieldsOf(x, { invoiceId: inv.id, issuerUid: x.uid, createdAt: sentAt, revoked: false }) }, currentDocument: { exists: false } },
      ],
      audit: [{ action: "invoice.status", ref: `invoices/${inv.id}`, before: { status: "draft" }, after: { status: "sent", number } }], result: null };
  });
  return { invoice: await presentInvoice(x, out, true) };
}

async function opInvCancel(x) {
  let out;
  await commitAudited(x, async () => {
    const inv = await loadInvoice(x, x.p.id);
    C.assertTransition(inv.status, "cancelled");
    if ((inv.amountPaid || 0) > 0) throw new C.PfmError("has_payments", "record a refund instead");
    const reason = txt(x.p.reason, 200, "reason") || "";
    const patch = { status: "cancelled", cancelledAt: now(), cancelReason: reason ? await seal(x, reason) : "", rev: inv.rev + 1, updatedAt: now() };
    out = { ...inv, ...patch };
    const writes = [{ update: { name: P(x, `invoices/${inv.id}`), fields: fieldsOf(x, patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime: inv._updateTime } }];
    if (inv.payLinkToken) writes.push({ update: { name: P(x, `payLinks/${inv.payLinkToken}`), fields: fieldsOf(x, { revoked: true }) }, updateMask: { fieldPaths: ["revoked"] } });
    return { writes, audit: [{ action: "invoice.status", ref: `invoices/${inv.id}`, before: { status: inv.status }, after: { status: "cancelled" } }], result: null };
  });
  return { invoice: await presentInvoice(x, out, true) };
}

// The issuer records money received outside Sawa (cash, bank, mobile money). The payment document id is the
// client's idempotency key, so a double tap records one payment. The same commit books the income in the ledger.
const PAY_METHODS = ["cash", "bank_transfer", "mobile_money", "other"];
async function opInvMarkPaid(x) {
  const p = x.p;
  if (!ID_RE.test(p.idemKey || "")) throw new C.PfmError("bad_idem_key");
  if (!PAY_METHODS.includes(p.method)) throw new C.PfmError("bad_method");
  let out;
  await commitAudited(x, async () => {
    const inv = await loadInvoice(x, p.id);
    const payId = "p_" + p.idemKey;
    if (await x.d.fsGet(x.token, `invoices/${inv.id}/payments/${payId}`)) { out = inv; return { result: null }; }
    const s = await settingsOf(x), cats = await categoryMap(x);
    const amount = C.toMinor(p.amount, inv.currency);
    // The issuer may always record part of the money; allowPartial governs what a payer can choose.
    const next = C.applyPayment({ status: inv.status, total: inv.totals.total, amountPaid: inv.amountPaid || 0, allowPartial: true }, amount);
    const paidAt = p.paidAt || C.localDate(s.tz);
    if (!DATE.test(paidAt)) throw new C.PfmError("bad_date");
    const reference = txt(p.reference, 80, "reference") || "";
    const pay = { amount, currency: inv.currency, method: p.method, state: "succeeded", at: paidAt, reference: reference ? await seal(x, reference) : "",
      payoutAccountId: p.payoutAccountId || null, recordedAt: now() };
    const tx = await buildTx(x, s, cats, { kind: "income", amount: C.fromMinor(amount, inv.currency), currency: inv.currency, fxRate: p.fxRate, categoryId: "c_invoices",
      date: paidAt, counterparty: inv.client?.name ? await C.openField(inv.client.name, x.uid, keys(x)).catch(() => null) : null, note: inv.number || null, source: "invoice" }, null);
    const txRow = { ...tx, invoiceId: inv.id, autoCategorized: false, rev: 1, createdAt: now(), updatedAt: now() };
    const patch = { amountPaid: next.amountPaid, status: next.status, rev: inv.rev + 1, updatedAt: now(), ...(next.status === "paid" ? { paidAt } : {}) };
    out = { ...inv, ...patch };
    const writes = [
      { update: { name: P(x, `invoices/${inv.id}/payments/${payId}`), fields: fieldsOf(x, pay) }, currentDocument: { exists: false } },
      { update: { name: P(x, `invoices/${inv.id}`), fields: fieldsOf(x, patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime: inv._updateTime } },
      { update: { name: P(x, `pfm/${x.uid}/tx/i_${inv.id.slice(3)}_${payId}`), fields: fieldsOf(x, txRow) }, currentDocument: { exists: false } },
      ...rollupWrites(x, C.rollupDiff(null, txRow)),
    ];
    if (!s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
    return { writes, audit: [{ action: "invoice.payment", ref: `invoices/${inv.id}`, after: { amount, method: p.method, status: next.status } }], result: null };
  });
  return { invoice: await presentInvoice(x, out, true) };
}

// Printable page (issuer only). The phone prints it to PDF; the Browser Rendering pipeline (invoice-pdf.mjs)
// can take over once its R2 bucket and binding exist.
async function opInvHtml(x) {
  const inv = await presentInvoice(x, await loadInvoice(x, x.p.id));
  const s = await settingsOf(x), biz = await bizOf(x, s);
  const logo = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/files/logo`));
  const issuer = inv.status === "draft" ? { name: biz.name, contact: biz.contact, address: biz.address, taxId: biz.taxId } : inv.issuer;
  let accounts = inv.payoutAccounts;
  if (inv.status === "draft") accounts = C.accountsForInvoice(await accountsOf(x, false), inv.payoutAccountIds || [], inv.currency);
  const lang = x.p.lang === "en" || x.p.lang === "ar" ? x.p.lang : inv.lang;
  const html = renderInvoiceHtml({ ...inv, lang, number: inv.number || (lang === "ar" ? "مسوّدة" : "Draft"), issuer: { ...issuer, logoDataUri: logo ? logo.data : null },
    client: inv.client, payoutAccounts: accounts, methods: [], payUrl: null }, inv.totals);
  return { html, number: inv.number, status: inv.status };
}

// Cron: sent invoices past their due date (in the issuer's time zone) become overdue; the issuer is told once.
async function overdueSweep(env, d, token, max) {
  const docs = await d.runQuery(token, { from: [{ collectionId: "invoices" }],
    where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "sent" } } }, limit: Math.max(max * 5, 50) });
  const zones = new Map(); let n = 0;
  for (const doc of docs) {
    const inv0 = { ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, d.fsToJs(v)])) };
    const uid = inv0.issuerUid;
    const x = { uid, env, d, token, p: {} };
    try {
      if (!zones.has(uid)) zones.set(uid, await settingsOf(x, false));
      const s = zones.get(uid); if (!s) continue;
      if (!C.isOverdue(inv0, C.localDate(s.tz))) continue;
      let flipped = false;
      await commitAudited(x, async () => {
        const inv = js(x, await d.fsGet(token, `invoices/${doc.name.split("/").pop()}`));
        if (!inv || inv.status !== "sent") return { result: null };
        flipped = true;
        return { writes: [{ update: { name: P(x, `invoices/${inv.id}`), fields: fieldsOf(x, { status: "overdue", overdueAt: now(), updatedAt: now() }) }, updateMask: { fieldPaths: ["status", "overdueAt", "updatedAt"] }, currentDocument: { updateTime: inv._updateTime } }],
          audit: [{ action: "invoice.status", ref: `invoices/${inv.id}`, before: { status: "sent" }, after: { status: "overdue" }, actor: "system:cron" }], result: null };
      });
      if (flipped) {
        n++;
        if (d.push) {
          const ar = s.locale !== "en";
          await d.push(token, uid, ar ? `الفاتورة ${inv0.number} متأخّرة` : `Invoice ${inv0.number} is overdue`,
            ar ? `كان استحقاقها ${inv0.dueDate}. سجّل الدفعة إن وصلتك، أو ذكّر العميل.` : `It was due on ${inv0.dueDate}. Record the payment if it arrived, or remind the client.`).catch(() => 0);
        }
      }
    } catch (e) { /* next invoice */ }
  }
  return n;
}

// =====================================================================================================
// P4: public pay page (no login) · "I've paid" claims · issuer confirms or rejects
// =====================================================================================================

export const PAY_ORIGIN = "https://www.sawaaap.com";
const payUrl = (token) => `${PAY_ORIGIN}/pay/${token}`;
async function opInvLink(x) {
  const inv = await loadInvoice(x, x.p.id);
  if (!inv.payLinkToken || inv.status === "draft") throw new C.PfmError("not_sent");
  return { url: payUrl(inv.payLinkToken) };
}

// Best-effort per-IP limiter for the public endpoint (per Worker isolate). The durable limits are in the data:
// at most 5 open claims per invoice, and claims can't exceed what is due.
const IPL = new Map();
function ipOk(ip, kind, max, windowMs) {
  const k = kind + "|" + ip, t = Date.now(), e = IPL.get(k);
  if (!e || t - e.t > windowMs) { IPL.set(k, { t, n: 1 }); if (IPL.size > 5000) for (const [kk, v] of IPL) if (t - v.t > windowMs) IPL.delete(kk); return true; }
  return ++e.n <= max;
}

const TOKEN_RE = /^[a-z0-9]{22}$/;
async function invoiceByToken(x, token) {
  if (!TOKEN_RE.test(token || "")) throw new C.PfmError("not_found", "link");
  const link = js(x, await x.d.fsGet(x.token, `payLinks/${token}`));
  if (!link) throw new C.PfmError("not_found", "link");
  const inv = js(x, await x.d.fsGet(x.token, `invoices/${link.invoiceId}`));
  if (!inv || inv.issuerUid !== link.issuerUid) throw new C.PfmError("not_found", "link");
  return { link, inv };
}

// Entry point for POST /pfm/pay (no Authorization). Only these two operations exist here.
export async function handlePfmPublic(op, payload, env, d, ip) {
  if (!env.PFM_KEK_v1) throw new Error("pfm_not_configured");
  const p = payload && typeof payload === "object" ? payload : {};
  if (op !== "pay.view" && op !== "pay.claim") throw new Error("unknown op: " + op);
  try {
    if (op === "pay.view" ? !ipOk(ip, "v", 60, 60000) : !ipOk(ip, "c", 5, 600000)) throw new C.PfmError("rate_limited");
    const token = await d.getToken(env);
    // The issuer's uid comes from the link, never from the request.
    const pre = { env, d, token, p };
    const { link, inv } = await invoiceByToken(pre, p.token);
    const x = { ...pre, uid: link.issuerUid };
    return op === "pay.view" ? await payView(x, link, inv) : await payClaim(x, link, inv);
  } catch (e) {
    if (e instanceof C.PfmError) throw new Error(e.code + (e.message && e.message !== e.code ? ": " + String(e.message).slice(0, 80) : ""));
    throw e;
  }
}

async function payView(x, link, inv) {
  const pi = await presentInvoice(x, inv);
  const s = await settingsOf(x, false);
  const logo = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/files/logo`));
  const lang = x.p.lang === "en" || x.p.lang === "ar" ? x.p.lang : pi.lang;
  const payable = !link.revoked && (pi.status === "sent" || pi.status === "overdue");
  const html = renderInvoiceHtml({ ...pi, lang, issuer: { ...pi.issuer, logoDataUri: logo ? logo.data : null }, methods: [], payUrl: null }, pi.totals);
  const accounts = (pi.payoutAccounts || []).map((a) => ({ id: a.id, type: a.type, label: a.label, holderName: a.holderName, bankName: a.bankName, provider: a.provider,
    branch: a.branch, details: a.details, number: a.number, currency: a.currency }));
  return {
    status: link.revoked && pi.status !== "paid" ? "cancelled" : pi.status, number: pi.number, lang: pi.lang, currency: pi.currency,
    issuer: { name: pi.issuer?.name || "", logo: logo ? logo.data : null }, client: { name: pi.client.name },
    issueDate: pi.issueDate, dueDate: pi.dueDate, total: pi.totals.total, amountPaid: pi.totals.amountPaid, amountDue: pi.totals.amountDue,
    pendingClaims: inv.claimedAmount || 0, allowPartial: pi.allowPartial !== false, payable,
    items: pi.items.map((it, i) => ({ description: it.description, qty: it.qty, amount: pi.totals.lines[i].amount })),
    taxTotal: pi.totals.taxTotal, taxLabel: pi.taxLabel, accounts, methods: payable && accounts.length ? ["transfer"] : [], html,
    tz: s ? s.tz : "UTC",
  };
}

// "I've paid": recorded as a claim. It changes nothing on the invoice until the issuer confirms.
async function payClaim(x, link, inv0) {
  const p = x.p;
  if (!ID_RE.test(p.idemKey || "")) throw new C.PfmError("bad_idem_key");
  const payId = "c_" + p.idemKey;
  let out, fresh = false;
  await commitAudited(x, async () => {
    const inv = js(x, await x.d.fsGet(x.token, `invoices/${inv0.id}`));
    const existing = js(x, await x.d.fsGet(x.token, `invoices/${inv.id}/payments/${payId}`));
    if (existing) { out = { payId, state: existing.state }; return { result: null }; }
    if (link.revoked || !(inv.status === "sent" || inv.status === "overdue")) throw new C.PfmError("not_payable", inv.status);
    if ((inv.openClaims || 0) >= 5) throw new C.PfmError("claim_pending", "the issuer has not answered earlier reports yet");
    const amount = C.toMinor(p.amount, inv.currency);
    const room = inv.totals.total - (inv.amountPaid || 0) - (inv.claimedAmount || 0);
    if (amount <= 0) throw new C.PfmError("bad_amount");
    if (amount > room) throw new C.PfmError("overpay", "due " + room);
    if (inv.allowPartial === false && amount !== room) throw new C.PfmError("partial_not_allowed", "due " + room);
    const acct = (inv.payoutAccounts || []).find((a) => a.id === p.payoutAccountId);
    if (!acct) throw new C.PfmError("bad_account");
    const name = txt(p.payer?.name, 80, "name");
    if (!name) throw new C.PfmError("bad_payer", "name");
    const phone = txt(p.payer?.phone, 30, "phone");
    const reference = txt(p.reference, 80, "reference");
    const s = await settingsOf(x);
    const today = C.localDate(s.tz);
    const at = p.paidAt && DATE.test(p.paidAt) && p.paidAt <= today ? p.paidAt : today;
    let proofDoc = null;
    if (p.proof) {
      const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p.proof));
      if (!m) throw new C.PfmError("bad_proof");
      const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
      if (bytes.length > 400 * 1024) throw new C.PfmError("bad_proof", "too_big");
      let type; try { type = C.sniffLogo(bytes.length > 512 * 1024 ? bytes.subarray(0, 64) : bytes); } catch { throw new C.PfmError("bad_proof"); }
      if (type !== m[1]) throw new C.PfmError("bad_proof");
      proofDoc = { data: `data:${type};base64,${m[3]}`, size: bytes.length, at: now() };
    }
    const method = acct.type === "mobile_money" ? "mobile_money" : acct.type === "bank" ? "bank_transfer" : "other";
    const pay = { amount, currency: inv.currency, method, state: "claimed", at, payoutAccountId: acct.id, reference: reference ? await seal(x, reference) : "",
      payer: { name: await seal(x, name), phone: phone ? await seal(x, phone) : "" }, hasProof: !!proofDoc, claimedAt: now() };
    out = { payId, state: "claimed" }; fresh = { name, amount, number: inv.number, currency: inv.currency, locale: s.locale };
    const writes = [
      { update: { name: P(x, `invoices/${inv.id}/payments/${payId}`), fields: fieldsOf(x, pay) }, currentDocument: { exists: false } },
      { transform: { document: P(x, `invoices/${inv.id}`), fieldTransforms: [{ fieldPath: "openClaims", increment: { integerValue: "1" } }, { fieldPath: "claimedAmount", increment: { integerValue: String(amount) } }] } },
    ];
    if (proofDoc) writes.push({ update: { name: P(x, `invoices/${inv.id}/proofs/${payId}`), fields: fieldsOf(x, proofDoc) } });
    // the invoice's updateTime guards the "room" check against a concurrent claim or payment
    writes.push({ update: { name: P(x, `invoices/${inv.id}`), fields: fieldsOf(x, { updatedAt: now() }) }, updateMask: { fieldPaths: ["updatedAt"] }, currentDocument: { updateTime: inv._updateTime } });
    return { writes, audit: [{ action: "invoice.claim", ref: `invoices/${inv.id}`, after: { amount, method, payId }, actor: "payer" }], result: null };
  });
  if (fresh && x.d.push) {
    const ar = fresh.locale !== "en", amt = moneyText(fresh.amount, fresh.currency);
    await x.d.push(x.token, x.uid, ar ? `أبلغ ${fresh.name} عن دفع ${amt}` : `${fresh.name} reports paying ${amt}`,
      ar ? `الفاتورة ${fresh.number} — تحقّق من حسابك ثمّ أكّد الدفعة أو ارفضها.` : `Invoice ${fresh.number} — check your account, then confirm or reject the payment.`).catch(() => 0);
  }
  return out;
}

async function opClaimProof(x) {
  const inv = await loadInvoice(x, x.p.id);
  const d0 = js(x, await x.d.fsGet(x.token, `invoices/${inv.id}/proofs/${segId(x.p.payId)}`));
  return { data: d0 ? d0.data : null };
}

// The issuer decides. Confirm = the same booking as a recorded payment (invoice totals, ledger income).
async function opClaimDecide(x) {
  const p = x.p, confirm = p.decision === "confirm";
  if (!confirm && p.decision !== "reject") throw new C.PfmError("bad_decision");
  let out;
  await commitAudited(x, async () => {
    const inv = await loadInvoice(x, p.id);
    const payId = segId(p.payId);
    const pay = js(x, await x.d.fsGet(x.token, `invoices/${inv.id}/payments/${payId}`));
    if (!pay || pay.state !== "claimed") throw new C.PfmError("not_found", "open claim");
    const undoClaim = { transform: { document: P(x, `invoices/${inv.id}`), fieldTransforms: [{ fieldPath: "openClaims", increment: { integerValue: "-1" } }, { fieldPath: "claimedAmount", increment: { integerValue: String(-pay.amount) } }] } };
    const note = txt(p.note, 200, "note");
    if (!confirm) {
      out = inv;
      return { writes: [{ update: { name: P(x, `invoices/${inv.id}/payments/${payId}`), fields: fieldsOf(x, { state: "rejected", decidedAt: now(), note: note ? await seal(x, note) : "" }) },
        updateMask: { fieldPaths: ["state", "decidedAt", "note"] }, currentDocument: { updateTime: pay._updateTime } }, undoClaim],
        audit: [{ action: "invoice.claim.reject", ref: `invoices/${inv.id}`, after: { payId } }], result: null };
    }
    // the issuer may correct the amount to what actually arrived
    const amount = p.amount != null ? C.toMinor(p.amount, inv.currency) : pay.amount;
    const next = C.applyPayment({ status: inv.status, total: inv.totals.total, amountPaid: inv.amountPaid || 0, allowPartial: true }, amount);
    const s = await settingsOf(x), cats = await categoryMap(x);
    const payer = pay.payer?.name ? await C.openField(pay.payer.name, x.uid, keys(x)).catch(() => null) : null;
    const tx = await buildTx(x, s, cats, { kind: "income", amount: C.fromMinor(amount, inv.currency), currency: inv.currency, fxRate: p.fxRate, categoryId: "c_invoices",
      date: pay.at, counterparty: payer || (inv.client?.name ? await C.openField(inv.client.name, x.uid, keys(x)).catch(() => null) : null), note: inv.number || null, source: "invoice" }, null);
    const txRow = { ...tx, invoiceId: inv.id, autoCategorized: false, rev: 1, createdAt: now(), updatedAt: now() };
    const patch = { amountPaid: next.amountPaid, status: next.status, rev: inv.rev + 1, updatedAt: now(), ...(next.status === "paid" ? { paidAt: pay.at } : {}) };
    out = { ...inv, ...patch };
    const writes = [
      { update: { name: P(x, `invoices/${inv.id}/payments/${payId}`), fields: fieldsOf(x, { state: "succeeded", amount, decidedAt: now(), note: note ? await seal(x, note) : "" }) },
        updateMask: { fieldPaths: ["state", "amount", "decidedAt", "note"] }, currentDocument: { updateTime: pay._updateTime } },
      { update: { name: P(x, `invoices/${inv.id}`), fields: fieldsOf(x, patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime: inv._updateTime } },
      undoClaim,
      { update: { name: P(x, `pfm/${x.uid}/tx/i_${inv.id.slice(3)}_${payId}`), fields: fieldsOf(x, txRow) }, currentDocument: { exists: false } },
      ...rollupWrites(x, C.rollupDiff(null, txRow)),
    ];
    if (!s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
    return { writes, audit: [{ action: "invoice.claim.confirm", ref: `invoices/${inv.id}`, after: { payId, amount, status: next.status } }], result: null };
  });
  return { invoice: await presentInvoice(x, out, true) };
}

// Open "I've paid" reports across the user's invoices (for "Needs you").
async function claimsOf(x) {
  if (!x.d.runQuery) return 0;
  const docs = await x.d.runQuery(x.token, { from: [{ collectionId: "invoices" }], where: { fieldFilter: { field: { fieldPath: "issuerUid" }, op: "EQUAL", value: { stringValue: x.uid } } }, limit: 500 }).catch(() => []);
  return docs.reduce((a, dd) => a + (Number(dd.fields && dd.fields.openClaims && dd.fields.openClaims.integerValue) || 0), 0);
}

// =====================================================================================================
// P5: receipt photos on ledger entries · CSV export
// =====================================================================================================

// A data: URI image, judged by its bytes. Shared by receipts; the size is checked before decoding.
export function checkImageData(data, code, max) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ""));
  if (!m) throw new C.PfmError(code, "type");
  if (m[3].length > Math.ceil(max / 3) * 4 + 4) throw new C.PfmError(code, "too_big");
  const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
  if (bytes.length > max) throw new C.PfmError(code, "too_big");
  let type; try { type = C.sniffLogo(bytes); } catch { throw new C.PfmError(code, "type"); }
  if (type !== m[1]) throw new C.PfmError(code, "type");
  return { type, b64: m[3], bytes };
}

// One photo per entry at pfm/{uid}/files/r_{txId}, sealed like notes (a receipt can show card digits or an
// address). ≤ 400 KB: the phone shrinks it to ≤ 1280 px JPEG first. The row only carries hasReceipt.
export const RECEIPT_MAX = 400 * 1024;
const receiptPath = (x, id) => `pfm/${x.uid}/files/r_${id}`;
async function loadLiveTx(x) {
  const id = segId(x.p.id);
  const tx = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/tx/${id}`));
  if (!tx || tx.deleted) throw new C.PfmError("not_found", "transaction");
  return tx;
}
async function opReceiptSet(x) {
  const img = checkImageData(x.p.data, "bad_receipt", RECEIPT_MAX);
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", img.bytes))].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const sealed = await seal(x, `data:${img.type};base64,${img.b64}`);
  await commitAudited(x, async () => {
    const tx = await loadLiveTx(x);
    return { writes: [
        { update: { name: P(x, receiptPath(x, tx.id)), fields: fieldsOf(x, { data: sealed, type: img.type, sha, size: img.bytes.length, txId: tx.id, updatedAt: now() }) } },
        { update: { name: P(x, `pfm/${x.uid}/tx/${tx.id}`), fields: fieldsOf(x, { hasReceipt: true }) }, updateMask: { fieldPaths: ["hasReceipt"] }, currentDocument: { updateTime: tx._updateTime } }],
      audit: [{ action: "tx.receipt.set", ref: `tx/${tx.id}`, after: { sha, size: img.bytes.length } }], result: null };
  });
  return { id: x.p.id, hasReceipt: true, sha, size: img.bytes.length };
}
async function opReceiptGet(x) {
  const id = segId(x.p.id);
  const f = js(x, await x.d.fsGet(x.token, receiptPath(x, id)));
  if (!f) return { id, data: null };
  return { id, data: await C.openField(f.data, x.uid, keys(x)), type: f.type, size: f.size };
}
async function opReceiptDelete(x) {
  await commitAudited(x, async () => {
    const tx = await loadLiveTx(x);
    if (!tx.hasReceipt) return { result: null };
    return { writes: [
        { delete: P(x, receiptPath(x, tx.id)) },
        { update: { name: P(x, `pfm/${x.uid}/tx/${tx.id}`), fields: fieldsOf(x, { hasReceipt: false }) }, updateMask: { fieldPaths: ["hasReceipt"] }, currentDocument: { updateTime: tx._updateTime } }],
      audit: [{ action: "tx.receipt.delete", ref: `tx/${tx.id}` }], result: null };
  });
  return { id: x.p.id, hasReceipt: false };
}

// CSV of booked entries for budget months from..to (≤ 24). Returned in the response; the app saves it as a
// file (no R2 yet, as with the logo). UTF-8 with a BOM so spreadsheet apps read Arabic correctly. Suggested rows
// (not confirmed) and deleted rows are left out. Text cells that a spreadsheet would run as a formula get a
// leading apostrophe.
export const EXPORT_CAP = 5000;
export function csvCell(v, text) {
  let s = v == null ? "" : String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function opExport(x) {
  const s = await settingsOf(x);
  const cur = C.budgetMonth(C.localDate(s.tz), s.monthStartDay);
  const to = x.p.to || cur, from = x.p.from || to;
  const months = monthRange(from, to);
  const ar = (x.p.lang || (s.locale === "en" ? "en" : "ar")) !== "en";
  const cats = await categoryMap(x);
  let rows = [], truncated = false;
  for (const m of months) {
    const docs = await x.d.fsQuerySub(x.token, `pfm/${x.uid}`, "tx", [["month", "EQUAL", m]], LIST_CAP);
    if (docs.length >= LIST_CAP) truncated = true;
    for (const dd of docs) { const t = js(x, dd); if (!t.deleted && t.status === "booked") rows.push(t); }
    if (rows.length > EXPORT_CAP) { truncated = true; break; }
  }
  rows.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1));
  if (rows.length > EXPORT_CAP) rows = rows.slice(0, EXPORT_CAP);
  const base = s.baseCurrency;
  const head = ar
    ? ["التاريخ", "النوع", "الفئة", "المبلغ", "العملة", "المبلغ بـ" + base, "سعر الصرف", "الطرف", "ملاحظة", "إيصال"]
    : ["Date", "Type", "Category", "Amount", "Currency", "Amount in " + base, "Exchange rate", "Paid to / from", "Note", "Receipt"];
  const lines = [head.map((h) => csvCell(h, true)).join(",")];
  for (const r of rows) {
    const t = await present(x, r), c = cats.get(t.categoryId);
    const cat = c ? (ar ? c.nameAr || c.name : c.name) : "";
    const type = t.kind === "income" ? (ar ? "دخل" : "Income") : (ar ? "مصروف" : "Expense");
    lines.push([csvCell(t.date), csvCell(type, true), csvCell(cat, true), csvCell(C.fromMinor(t.amount, t.currency)), csvCell(t.currency),
      csvCell(t.baseAmount == null ? "" : C.fromMinor(t.baseAmount, base)), csvCell(t.baseAmount == null ? "" : t.fxRate),
      csvCell(t.counterparty, true), csvCell(t.note, true), csvCell(t.hasReceipt ? (ar ? "نعم" : "yes") : "")].join(","));
  }
  return { filename: `sawa-accountant-${months[0]}_${months[months.length - 1]}.csv`, csv: "﻿" + lines.join("\r\n") + "\r\n",
    rows: rows.length, truncated, from: months[0], to: months[months.length - 1] };
}

// =====================================================================================================
// Projects, shared between users (PROJECTS.md §2, §3, §5). The rules are in projects-core.mjs; this part reads,
// checks roles and commits. Project data is top-level (`pfmProjects/{pid}`) so members can reach it. Each user has a
// `pfm/{uid}/projectIndex/{pid}` for their list. Every op checks the caller's `members/{uid}` role.
// Sealed text is bound to the project (`proj:{pid}`), so every member can open it through the Worker.
// Every mutation is one commit: preconditions on the project row serialise writes to one project.
// =====================================================================================================

const PROJ_MAX_LINES = 400;     // a commit holds at most 500 writes
const PROJ_MAX_TX = 3000;       // fsList reads at most 3000 rows
const pbind = (pid) => "proj:" + pid;
const sealP = (x, pid, v) => (v ? C.sealField(v, pbind(pid), ...curKey(x)) : null);
const openP = (x, pid, s) => (s ? C.openField(s, pbind(pid), keys(x)).catch(() => null) : null);

const PJ_OPS = {
  "pfm.proj.create": opProjCreate,
  "pfm.proj.list": opProjList,
  "pfm.proj.get": opProjGet,
  "pfm.proj.update": opProjUpdate,
  "pfm.proj.status": opProjStatus,
  "pfm.proj.delete": opProjDelete,
  "pfm.proj.estimate.create": opEstCreate,
  "pfm.proj.estimate.lines": opEstLines,
  "pfm.proj.estimate.approve": opEstApprove,
  "pfm.proj.tx.add": opPtxAdd,
  "pfm.proj.tx.void": opPtxVoid,
  "pfm.proj.tx.list": opPtxList,
  "pfm.proj.health": opProjHealth,
  "pfm.proj.variance": opProjVariance,
  "pfm.proj.charts": opProjCharts,
  "pfm.proj.alerts.list": opProjAlertsList,
  "pfm.proj.alerts.ack": opProjAlertAck,
  "pfm.proj.members.list": opMembersList,
  "pfm.proj.members.role": opMembersRole,
  "pfm.proj.members.remove": opMembersRemove,
  "pfm.proj.invite.create": opInviteCreate,
  "pfm.proj.invite.accept": opInviteAccept,
};
Object.assign(OPS, PJ_OPS);
PFM_OPS.push(...Object.keys(PJ_OPS));

// ---------- small helpers ----------

// Brings the user's Projects data to the code's schema version. Cheap when already current (one read).
async function projSchemaReady(x) {
  await migrateProjects({
    get: async (path) => js(x, await x.d.fsGet(x.token, path)),
    set: async (path, data) => { await x.d.fsCommit(x.token, [{ update: { name: P(x, path), fields: fieldsOf(x, data) } }]); },
  }, x.uid, { now });
}
// Reads take paths relative to the document root; writes use P(x, rel), which adds the root.
const getDoc = async (x, rel) => js(x, await x.d.fsGet(x.token, rel));
const listDocs = async (x, rel) => (await x.d.fsList(x.token, rel)).map((d) => js(x, d));
const createAt = (x, rel, data) => ({ update: { name: P(x, rel), fields: fieldsOf(x, data) }, currentDocument: { exists: false } });
const updateAt = (x, rel, data, mask, updateTime) => ({
  update: { name: P(x, rel), fields: fieldsOf(x, data) },
  ...(mask ? { updateMask: { fieldPaths: mask } } : {}),
  currentDocument: { updateTime },
});
const deleteAt = (x, rel) => ({ delete: P(x, rel) });
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
// The fields that differ between two plain objects: { before, after }
function diffKeys(a, b) {
  const before = {}, after = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) { before[k] = a[k] ?? null; after[k] = b[k] ?? null; }
  return { before, after };
}
const linesOf = (x, pid, eid) => listDocs(x, J.paths.lines(pid, eid));
const txsOf = (x, pid) => listDocs(x, J.paths.tx(pid));
const alertsOf = (x, pid) => listDocs(x, J.paths.alerts(pid));
const membersOf = (x, pid) => listDocs(x, J.paths.members(pid));
async function estimatesOf(x, pid) {
  return (await listDocs(x, J.paths.estimates(pid))).sort((a, b) => a.revision - b.revision);
}
async function estimateOf(x, pid, eid) {
  const e = await getDoc(x, J.paths.estimate(pid, eid));
  if (!e) throw new C.PfmError("not_found", "estimate");
  return e;
}
// The caller's role on a project. Someone who is not a member gets not_found, so the project's existence is not revealed.
async function accessOf(x, pid, need = "viewer") {
  const p = await getDoc(x, J.paths.project(pid));
  const m = p ? await getDoc(x, J.paths.member(pid, x.uid)) : null;
  if (!p || !m) throw new C.PfmError("not_found", "project");
  J.assertRole(m.role, need);
  return { p, role: m.role };
}
const projView = (p) => ({ currency: p.currency, targetBudget: p.targetBudget, alertThresholdsPct: p.alertThresholdsPct, lineTolerancePct: p.lineTolerancePct });
const lineInput = (r) => ({ lineKey: r.id, category: r.category, estQty: r.estQty, estUnitPrice: r.estUnitPrice, estTotal: r.estTotal });
// The health of a project for an estimate (default: the baseline). Without a baseline only the ledger counts.
async function healthFor(x, p, eid, txs = null) {
  const est = eid === undefined ? p.baselineEstimateId || null : eid;
  const lines = est ? (await linesOf(x, p.id, est)).map(lineInput) : [];
  const rows = txs || (await txsOf(x, p.id));
  return { estimateId: est, health: J.projectHealth(projView(p), lines, rows) };
}
// Alert documents: create what is newly true, delete what no longer applies for this revision.
function alertWrites(x, pid, eid, health, stored) {
  const { create, clear } = J.alertsFor(health, eid, stored.map((a) => a.id));
  return [
    ...create.map((a) => createAt(x, `${J.paths.alerts(pid)}/${a.dedupeKey}`, { ...a, estimateId: eid, createdAt: now(), acknowledgedAt: null })),
    ...clear.map((k) => deleteAt(x, `${J.paths.alerts(pid)}/${k}`)),
  ];
}
const projFields = (v, description) => ({
  name: v.name, template: v.template, description, currency: v.currency,
  startDate: v.startDate, endDate: v.endDate, targetBudget: v.targetBudget,
  alertThresholdsPct: v.alertThresholdsPct, lineTolerancePct: v.lineTolerancePct,
});
const projAudit = (r) => pick(r, ["name", "template", "currency", "startDate", "endDate", "targetBudget", "alertThresholdsPct", "lineTolerancePct", "status"]);
async function presentProject(x, p) {
  const o = strip(p);
  o.description = await openP(x, p.id, p.description);
  return o;
}
async function presentTx(x, pid, t) {
  const o = strip(t);
  for (const k of ["description", "counterparty", "voidReason"]) o[k] = await openP(x, pid, t[k]);
  return o;
}
const ID_OF = (x, prefix) => { if (!ID_RE.test(x.p.idemKey || "")) throw new C.PfmError("bad_idem_key"); return prefix + x.p.idemKey; };
const memberName = (x) => txt(x.p.displayName, 40, "displayName");

// ---------- projects ----------

async function opProjCreate(x) {
  await projSchemaReady(x);
  await settingsOf(x);
  const pid = ID_OF(x, "p_");
  let out = null;
  await commitAudited(x, async () => {
    const existing = await getDoc(x, J.paths.project(pid));
    if (existing) { out = existing; return { result: null }; }
    const v = J.validateProjectInput(x.p);
    const row = { ...projFields(v, await sealP(x, pid, v.description)), ownerUid: x.uid, status: "planning", baselineEstimateId: null, rev: 1, createdAt: now(), updatedAt: now() };
    out = { id: pid, ...row };
    const at = now();
    return {
      writes: [
        createAt(x, J.paths.project(pid), row),
        createAt(x, J.paths.member(pid, x.uid), { role: "owner", displayName: memberName(x) ?? null, addedAt: at, addedBy: x.uid }),
        createAt(x, J.paths.index(x.uid, pid), { role: "owner", createdAt: at }),
      ],
      audit: [{ action: "project.create", ref: `projects/${pid}`, after: projAudit(row) }],
      result: null,
    };
  });
  return { project: await presentProject(x, out) };
}

async function opProjList(x) {
  await projSchemaReady(x);
  const items = [];
  const idx = (await listDocs(x, J.paths.indexes(x.uid))).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const ix of idx) {
    const p = await getDoc(x, J.paths.project(ix.id));
    if (!p) continue;
    const { health } = await healthFor(x, p, undefined);
    items.push({ ...(await presentProject(x, p)), role: ix.role,
      health: { status: health.status, utilizationBp: health.utilizationBp, actualSpend: health.actualSpend, forecastVsBudget: health.forecastVsBudget } });
  }
  return { items };
}

async function opProjGet(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const { p, role } = await accessOf(x, pid, "viewer");
  const estimates = (await estimatesOf(x, pid)).map((e) => ({ id: e.id, revision: e.revision, status: e.status, reason: e.reason ?? null, total: e.total ?? 0, lineCount: e.lineCount ?? 0, approvedAt: e.approvedAt ?? null }));
  const { estimateId, health } = await healthFor(x, p, undefined);
  const members = (await membersOf(x, pid)).length;
  return { project: await presentProject(x, p), role, members, estimates, estimateId, health };
}

async function opProjUpdate(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  let out;
  await commitAudited(x, async () => {
    const { p: old } = await accessOf(x, pid, "editor");
    if (x.p.rev !== old.rev) throw new C.PfmError("stale", "reload and try again");
    if (x.p.currency !== undefined && x.p.currency !== old.currency) throw new C.PfmError("currency_locked");
    const merged = {
      name: old.name, template: old.template, currency: old.currency, startDate: old.startDate, endDate: old.endDate,
      targetBudget: C.fromMinor(old.targetBudget, old.currency), alertThresholdsPct: old.alertThresholdsPct,
      lineTolerancePct: old.lineTolerancePct,
      description: x.p.description !== undefined ? x.p.description : await openP(x, pid, old.description),
      ...pick(x.p, ["name", "template", "startDate", "endDate", "targetBudget", "alertThresholdsPct", "lineTolerancePct"]),
    };
    const v = J.validateProjectInput(merged);
    const row = { ...projFields(v, await sealP(x, pid, v.description)), ownerUid: old.ownerUid, status: old.status, baselineEstimateId: old.baselineEstimateId ?? null, rev: old.rev + 1, createdAt: old.createdAt, updatedAt: now() };
    const { before, after } = diffKeys(projAudit(old), projAudit(row));
    if (!Object.keys(after).length) { out = { ...old, id: pid }; return { result: null }; }
    out = { id: pid, ...row };
    return {
      writes: [updateAt(x, J.paths.project(pid), row, null, old._updateTime)],
      audit: [{ action: "project.update", ref: `projects/${pid}`, before, after }],
      result: null,
    };
  });
  return { project: await presentProject(x, out) };
}

async function opProjStatus(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  let out;
  await commitAudited(x, async () => {
    const { p: old } = await accessOf(x, pid, "editor");
    if (x.p.rev !== old.rev) throw new C.PfmError("stale", "reload and try again");
    J.assertProjectTransition(old.status, x.p.to);
    const row = { status: x.p.to, rev: old.rev + 1, updatedAt: now() };
    out = { ...old, ...row, id: pid };
    return {
      writes: [updateAt(x, J.paths.project(pid), row, ["status", "rev", "updatedAt"], old._updateTime)],
      audit: [{ action: "project.status", ref: `projects/${pid}`, before: { status: old.status }, after: { status: x.p.to } }],
      result: null,
    };
  });
  return { project: await presentProject(x, out) };
}

// Deletes a project and everything under it, in batches of 300 deletes per commit. false = budget ran out.
async function drain(d, token, rel, spend) {
  for (;;) {
    const docs = await d.fsList(token, rel);
    if (!docs.length) return true;
    for (let i = 0; i < docs.length; i += 300) {
      if (!spend()) return false;
      await d.fsCommit(token, docs.slice(i, i + 300).map((doc) => ({ delete: doc.name })));
    }
  }
}
export async function dropProject(d, token, pid, spend) {
  const full = (rel) => d.DOC_ROOT + "/" + rel;
  for (const m of await d.fsList(token, J.paths.members(pid))) {        // members' index entries first
    if (!spend()) return false;
    await d.fsCommit(token, [{ delete: full(J.paths.index(m.name.split("/").pop(), pid)) }]);
  }
  for (const e of await d.fsList(token, J.paths.estimates(pid))) {
    if (!(await drain(d, token, J.paths.lines(pid, e.name.split("/").pop()), spend))) return false;
  }
  for (const rel of [J.paths.estimates(pid), J.paths.tx(pid), J.paths.alerts(pid), J.paths.members(pid)]) {
    if (!(await drain(d, token, rel, spend))) return false;
  }
  if (!spend()) return false;
  await d.fsCommit(token, [{ delete: full(J.paths.project(pid)) }]);
  return true;
}

async function opProjDelete(x) {
  const pid = segId(x.p.pid);
  await projSchemaReady(x);
  await accessOf(x, pid, "owner");
  if (x.p.confirm !== pid) throw new C.PfmError("confirm_required", "send the project id as confirm");
  if (!(await dropProject(x.d, x.token, pid, () => true))) throw new C.PfmError("busy");
  await commitAudited(x, async () => ({ writes: [], audit: [{ action: "project.delete", ref: `projects/${pid}` }], result: null }));
  return { id: pid, deleted: true };
}

// ---------- estimates (BOQ) ----------

async function lineRow(x, pid, v, sortOrder) {
  return {
    category: v.category, unit: v.unit, estQty: J.qtyText(v.estQty), estUnitPrice: v.estUnitPrice, estTotal: v.estTotal,
    name: await sealP(x, pid, v.name), notes: await sealP(x, pid, txt(v.notes, 300, "notes")), sortOrder,
  };
}

async function opEstCreate(x) {
  await projSchemaReady(x);
  await settingsOf(x);
  const pid = segId(x.p.pid);
  const eid = ID_OF(x, "e_");
  let out;
  await commitAudited(x, async () => {
    const { p } = await accessOf(x, pid, "editor");
    const existing = await getDoc(x, J.paths.estimate(pid, eid));
    if (existing) { out = existing; return { result: null }; }
    if (!["planning", "active"].includes(p.status)) throw new C.PfmError("bad_project_status", p.status);
    const ests = await estimatesOf(x, pid);
    if (ests.some((e) => e.status === "draft")) throw new C.PfmError("draft_exists", "finish or delete the open revision first");
    const revision = J.nextRevision(ests);
    const reason = txt(x.p.reason, 200, "reason");
    if (revision > 1 && !reason) throw new C.PfmError("reason_required", "a change order needs a reason");
    let rows = [];
    if (x.p.fromBaseline) {
      if (!p.baselineEstimateId) throw new C.PfmError("no_baseline");
      rows = await linesOf(x, pid, p.baselineEstimateId);
    }
    if (rows.length > PROJ_MAX_LINES) throw new C.PfmError("too_many_lines", String(PROJ_MAX_LINES));
    const est = { revision, status: "draft", reason: reason || (revision === 1 ? "Initial estimate" : null), rev: 1,
      total: rows.reduce((s, r) => s + r.estTotal, 0), lineCount: rows.length, createdAt: now(), updatedAt: now() };
    out = { id: eid, ...est };
    return {
      writes: [
        createAt(x, J.paths.estimate(pid, eid), est),
        ...rows.map((r) => createAt(x, `${J.paths.lines(pid, eid)}/${r.id}`, pick(r, ["category", "unit", "estQty", "estUnitPrice", "estTotal", "name", "notes", "sortOrder"]))),
        updateAt(x, J.paths.project(pid), { rev: p.rev + 1, updatedAt: now() }, ["rev", "updatedAt"], p._updateTime),
      ],
      audit: [{ action: "estimate.create", ref: `projects/${pid}/estimates/${eid}`, after: { revision, lineCount: rows.length, total: est.total } }],
      result: null,
    };
  });
  return { estimate: strip(out) };
}

async function opEstLines(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid), eid = segId(x.p.eid);
  if (!Array.isArray(x.p.lines)) throw new C.PfmError("bad_lines");
  if (x.p.lines.length > PROJ_MAX_LINES) throw new C.PfmError("too_many_lines", String(PROJ_MAX_LINES));
  let out, totals = null;
  await commitAudited(x, async () => {
    const { p } = await accessOf(x, pid, "editor");
    const est = await estimateOf(x, pid, eid);
    if (x.p.rev !== est.rev) throw new C.PfmError("stale", "reload and try again");
    J.assertEstimateEditable(est);
    const checked = x.p.lines.map((l) => ({ ...J.validateBoqLine(l, p.currency), notes: l.notes }));
    J.assertUniqueLineKeys(checked);
    const rows = [];
    for (let i = 0; i < checked.length; i++) rows.push({ key: checked[i].lineKey, data: await lineRow(x, pid, checked[i], i) });
    totals = J.estimateTotals(checked);
    const keep = new Set(rows.map((r) => r.key));
    const old = await linesOf(x, pid, eid);
    const estRow = { rev: est.rev + 1, total: totals.total, lineCount: rows.length, updatedAt: now() };
    out = { id: eid, ...est, ...estRow };
    return {
      writes: [
        ...old.filter((r) => !keep.has(r.id)).map((r) => deleteAt(x, `${J.paths.lines(pid, eid)}/${r.id}`)),
        ...rows.map((r) => ({ update: { name: P(x, `${J.paths.lines(pid, eid)}/${r.key}`), fields: fieldsOf(x, r.data) } })),
        updateAt(x, J.paths.estimate(pid, eid), estRow, ["rev", "total", "lineCount", "updatedAt"], est._updateTime),
      ],
      audit: [{ action: "estimate.lines", ref: `projects/${pid}/estimates/${eid}`, after: { lineCount: rows.length, total: totals.total } }],
      result: null,
    };
  });
  return { estimate: strip(out), totals };
}

async function opEstApprove(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid), eid = segId(x.p.eid);
  let out;
  await commitAudited(x, async () => {
    const { p } = await accessOf(x, pid, "editor");
    const est = await estimateOf(x, pid, eid);
    if (x.p.rev !== est.rev) throw new C.PfmError("stale", "reload and try again");
    const lines = await linesOf(x, pid, eid);
    J.assertCanApprove(est, lines.map(lineInput), p);
    const prev = (await estimatesOf(x, pid)).find((e) => e.status === "baseline") || null;
    const at = now();
    const txs = await txsOf(x, pid);
    const health = J.projectHealth(projView(p), lines.map(lineInput), txs);
    const stored = await alertsOf(x, pid);
    out = { id: eid, ...est, status: "baseline", approvedAt: at, rev: est.rev + 1 };
    return {
      writes: [
        updateAt(x, J.paths.estimate(pid, eid), { status: "baseline", approvedAt: at, approvedBy: x.uid, rev: est.rev + 1 }, ["status", "approvedAt", "approvedBy", "rev"], est._updateTime),
        ...(prev ? [updateAt(x, J.paths.estimate(pid, prev.id), { status: "superseded", rev: prev.rev + 1 }, ["status", "rev"], prev._updateTime)] : []),
        updateAt(x, J.paths.project(pid), { baselineEstimateId: eid, status: p.status === "planning" ? "active" : p.status, rev: p.rev + 1, updatedAt: at }, ["baselineEstimateId", "status", "rev", "updatedAt"], p._updateTime),
        ...alertWrites(x, pid, eid, health, stored),
      ],
      audit: [{ action: "estimate.approve", ref: `projects/${pid}/estimates/${eid}`, after: { revision: est.revision, supersedes: prev ? prev.revision : null } }],
      result: null,
    };
  });
  return { estimate: strip(out) };
}

// ---------- project ledger ----------

// Adds an expense to the project. With copyToPersonal ({ categoryId }) it also books a linked row in the caller's own
// personal ledger, in the same commit. Only the caller's own copy is changed when the entry is voided later.
async function opPtxAdd(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const id = ID_OF(x, "x_");
  let out = null, copyId = null;
  await commitAudited(x, async () => {
    const existing = await getDoc(x, `${J.paths.tx(pid)}/${id}`);
    if (existing) { out = existing; return { result: null }; }
    const { p } = await accessOf(x, pid, "editor");
    const t = J.validateProjectTx(x.p, p);
    if (t.lineKey) {
      const lines = p.baselineEstimateId ? await linesOf(x, pid, p.baselineEstimateId) : [];
      if (!lines.some((l) => l.id === t.lineKey)) throw new C.PfmError("bad_line", "not on the baseline estimate");
    }
    const row = {
      kind: x.p.kind, direction: t.direction, occurredOn: t.occurredOn, amount: t.amount,
      originalAmount: t.originalAmount, originalCurrency: t.originalCurrency, fxRate: t.fxRate,
      lineKey: t.lineKey, category: t.category, quantity: t.quantity != null ? J.qtyText(t.quantity) : null, unit: t.unit,
      description: await sealP(x, pid, t.description), counterparty: await sealP(x, pid, t.counterparty),
      status: "posted", voidReason: null, walletTxId: null, createdBy: x.uid, createdAt: now(), rev: 1, personalCopy: null,
    };
    const writes = [];
    const audit = [];
    const s = x.p.copyToPersonal ? await settingsOf(x) : null;
    if (x.p.copyToPersonal) {
      if (t.kind !== "expense") throw new C.PfmError("copy_expense_only");
      const cats = await categoryMap(x);
      const cur = t.originalCurrency;
      if (cur !== s.baseCurrency && !x.p.personalFxRate) throw new C.PfmError("fx_rate_required", `personal ledger is in ${s.baseCurrency}`);
      const tp = { ...(await buildTx(x, s, cats, { kind: "expense", amount: x.p.amount, currency: cur, fxRate: x.p.personalFxRate,
        categoryId: x.p.copyToPersonal.categoryId, date: t.occurredOn, note: t.description, counterparty: t.counterparty }, null)),
        autoCategorized: false, rev: 1, createdAt: now(), updatedAt: now(), projectRef: { pid, txId: id } };
      copyId = "tp_" + id.slice(2);
      row.personalCopy = { uid: x.uid, txId: copyId };
      writes.push(createAt(x, `pfm/${x.uid}/tx/${copyId}`, tp), ...rollupWrites(x, C.rollupDiff(null, tp)));
      if (!s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
      audit.push({ action: "tx.add", ref: `tx/${copyId}`, after: auditView(tp) });
    }
    out = { id, ...row };
    const txs = await txsOf(x, pid);
    const health = (await healthFor(x, p, undefined, [...txs, { id, ...row }])).health;
    const stored = await alertsOf(x, pid);
    return {
      writes: [
        createAt(x, `${J.paths.tx(pid)}/${id}`, row),
        updateAt(x, J.paths.project(pid), { rev: p.rev + 1, updatedAt: now() }, ["rev", "updatedAt"], p._updateTime),
        ...(p.baselineEstimateId ? alertWrites(x, pid, p.baselineEstimateId, health, stored) : []),
        ...writes,
      ],
      audit: [{ action: "ptx.add", ref: `projects/${pid}/tx/${id}`, after: { kind: row.kind, amount: row.amount, originalCurrency: row.originalCurrency, lineKey: row.lineKey, category: row.category, quantity: row.quantity, occurredOn: row.occurredOn } }, ...audit],
      result: null,
    };
  });
  return { tx: await presentTx(x, pid, out), personalCopyId: copyId };
}

async function opPtxVoid(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid), txId = segId(x.p.txId);
  const reason = txt(x.p.reason, 200, "reason");
  if (!reason) throw new C.PfmError("reason_required");
  let out, kept = false;
  await commitAudited(x, async () => {
    const { p } = await accessOf(x, pid, "editor");
    const old = await getDoc(x, `${J.paths.tx(pid)}/${txId}`);
    if (!old) throw new C.PfmError("not_found", "entry");
    if (old.status === "voided") { out = old; return { result: null }; }
    const row = { status: "voided", voidReason: await sealP(x, pid, reason), voidedAt: now(), rev: old.rev + 1 };
    out = { ...old, ...row, id: txId };
    const txs = (await txsOf(x, pid)).map((t) => (t.id === txId ? { ...t, status: "voided" } : t));
    const stored = await alertsOf(x, pid);
    const health = (await healthFor(x, p, undefined, txs)).health;
    const writes = [
      updateAt(x, `${J.paths.tx(pid)}/${txId}`, row, ["status", "voidReason", "voidedAt", "rev"], old._updateTime),
      updateAt(x, J.paths.project(pid), { rev: p.rev + 1, updatedAt: now() }, ["rev", "updatedAt"], p._updateTime),
      ...(p.baselineEstimateId ? alertWrites(x, pid, p.baselineEstimateId, health, stored) : []),
    ];
    const audit = [{ action: "ptx.void", ref: `projects/${pid}/tx/${txId}`, before: { status: old.status }, after: { status: "voided" } }];
    const pc = old.personalCopy;
    if (pc && pc.uid === x.uid) {
      // The copy is in the caller's own ledger, so it is voided here too. Other members' copies are left alone.
      const tp = await getDoc(x, `pfm/${x.uid}/tx/${pc.txId}`);
      if (tp && !tp.deleted) {
        const nx = { ...strip(tp), deleted: true, rev: tp.rev + 1, updatedAt: now() }; delete nx.id;
        writes.push({ update: { name: P(x, `pfm/${x.uid}/tx/${pc.txId}`), fields: fieldsOf(x, nx) }, currentDocument: { updateTime: tp._updateTime } },
          ...rollupWrites(x, C.rollupDiff(tp, nx)));
        audit.push({ action: "tx.delete", ref: `tx/${pc.txId}`, before: auditView(tp) });
      }
    } else if (pc) kept = true;
    return { writes, audit, result: null };
  });
  return { tx: await presentTx(x, pid, out), personalCopyKept: kept };
}

async function opPtxList(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  await accessOf(x, pid, "viewer");
  let rows = await txsOf(x, pid);
  if (x.p.kind) rows = rows.filter((t) => t.kind === x.p.kind);
  if (x.p.lineKey) rows = rows.filter((t) => t.lineKey === x.p.lineKey);
  rows.sort((a, b) => (a.occurredOn === b.occurredOn ? (a.createdAt < b.createdAt ? 1 : -1) : a.occurredOn < b.occurredOn ? 1 : -1));
  return { items: await Promise.all(rows.map((t) => presentTx(x, pid, t))), truncated: rows.length >= PROJ_MAX_TX };
}

// ---------- analytics, charts, alerts ----------

async function opProjHealth(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const { p } = await accessOf(x, pid, "viewer");
  const { estimateId, health } = await healthFor(x, p, x.p.estimateId ? segId(x.p.estimateId) : undefined);
  return { estimateId, health };
}

async function opProjVariance(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const { p } = await accessOf(x, pid, "viewer");
  const eid = x.p.estimateId ? segId(x.p.estimateId) : p.baselineEstimateId || null;
  const { health } = await healthFor(x, p, eid);
  const rows = eid ? await linesOf(x, pid, eid) : [];
  const byKey = new Map(rows.map((r) => [r.id, r]));
  const lines = [];
  for (const v of health.lines) {
    const r = byKey.get(v.lineKey) || {};
    lines.push({ ...v, name: await openP(x, pid, r.name), unit: r.unit ?? null, category: r.category ?? null, notes: await openP(x, pid, r.notes) });
  }
  return { estimateId: eid, currency: p.currency, lines };
}

async function opProjCharts(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const { p } = await accessOf(x, pid, "viewer");
  const eid = x.p.estimateId ? segId(x.p.estimateId) : p.baselineEstimateId || null;
  const lines = eid ? await linesOf(x, pid, eid) : [];
  const txs = await txsOf(x, pid);
  const { health } = await healthFor(x, p, eid, txs);
  const series = J.chartSeries(lines.map((r) => ({ lineKey: r.id, category: r.category, estTotal: r.estTotal })), txs);
  return {
    estimateId: eid, currency: p.currency,
    budget: { target: health.targetBudget, spent: health.actualSpend, estimated: health.estimatedTotal, forecast: health.forecastAtCompletion,
      utilizationBp: health.utilizationBp, thresholdsCrossed: health.thresholdsCrossed, status: health.status },
    ...series,
  };
}

async function opProjAlertsList(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  await accessOf(x, pid, "viewer");
  let rows = await alertsOf(x, pid);
  if (x.p.unacknowledged) rows = rows.filter((a) => !a.acknowledgedAt);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { items: rows };
}

async function opProjAlertAck(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  // Alert keys look like "budget:100:e_…": colons are allowed here, nowhere else
  if (typeof x.p.key !== "string" || !/^[A-Za-z0-9_:-]{1,120}$/.test(x.p.key)) throw new C.PfmError("bad_id", "alert key");
  const key = x.p.key;
  let out;
  await commitAudited(x, async () => {
    await accessOf(x, pid, "editor");
    const a = await getDoc(x, `${J.paths.alerts(pid)}/${key}`);
    if (!a) throw new C.PfmError("not_found", "alert");
    if (a.acknowledgedAt) { out = a; return { result: null }; }
    const at = now();
    out = { ...a, acknowledgedAt: at };
    return {
      writes: [updateAt(x, `${J.paths.alerts(pid)}/${key}`, { acknowledgedAt: at }, ["acknowledgedAt"], a._updateTime)],
      audit: [{ action: "alert.ack", ref: `projects/${pid}/alerts/${key}`, after: { rule: a.rule } }],
      result: null,
    };
  });
  return { alert: strip(out) };
}

// ---------- members and invites ----------

async function opMembersList(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  await accessOf(x, pid, "viewer");
  const rows = (await membersOf(x, pid)).map((m) => ({ uid: m.id, role: m.role, displayName: m.displayName ?? null, addedAt: m.addedAt ?? null }));
  return { items: rows.sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.addedAt < b.addedAt ? -1 : 1)) };
}

async function opMembersRole(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const target = segId(x.p.uid);
  const role = x.p.role;
  if (!J.SHARE_ROLES.includes(role)) throw new C.PfmError("bad_role", String(role));
  let out;
  await commitAudited(x, async () => {
    await accessOf(x, pid, "owner");
    const m = await getDoc(x, J.paths.member(pid, target));
    if (!m) throw new C.PfmError("not_found", "member");
    if (m.role === "owner") throw new C.PfmError("owner_role_fixed");
    const ix = await getDoc(x, J.paths.index(target, pid));
    out = { uid: target, role };
    return {
      writes: [
        updateAt(x, J.paths.member(pid, target), { role }, ["role"], m._updateTime),
        ...(ix ? [updateAt(x, J.paths.index(target, pid), { role }, ["role"], ix._updateTime)] : []),
      ],
      audit: [{ action: "member.role", ref: `projects/${pid}/members/${target}`, before: { role: m.role }, after: { role } }],
      result: null,
    };
  });
  return { member: out };
}

// The owner removes anyone except themselves. Anyone else may remove only themselves (leave).
async function opMembersRemove(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const target = x.p.uid ? segId(x.p.uid) : x.uid;
  await commitAudited(x, async () => {
    const { role } = await accessOf(x, pid, "viewer");
    const m = await getDoc(x, J.paths.member(pid, target));
    if (!m) throw new C.PfmError("not_found", "member");
    if (target !== x.uid) J.assertRole(role, "owner");
    if (m.role === "owner") throw new C.PfmError("owner_cannot_leave", "delete the project instead");
    return {
      writes: [deleteAt(x, J.paths.member(pid, target)), deleteAt(x, J.paths.index(target, pid))],
      audit: [{ action: target === x.uid ? "member.leave" : "member.remove", ref: `projects/${pid}/members/${target}`, before: { role: m.role } }],
      result: null,
    };
  });
  return { removed: target };
}

// An invite is a token. It grants editor or viewer, can be used up to maxUses times, and expires.
async function opInviteCreate(x) {
  await projSchemaReady(x);
  const pid = segId(x.p.pid);
  const role = x.p.role ?? "viewer";
  if (!J.SHARE_ROLES.includes(role)) throw new C.PfmError("bad_role", String(role));
  const maxUses = x.p.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > J.INVITE_MAX_USES) throw new C.PfmError("bad_max_uses", `1 to ${J.INVITE_MAX_USES}`);
  const days = x.p.days ?? J.INVITE_DAYS.default;
  if (!Number.isInteger(days) || days < 1 || days > J.INVITE_DAYS.max) throw new C.PfmError("bad_days", `1 to ${J.INVITE_DAYS.max}`);
  const token = rid(24);
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  let out;
  await commitAudited(x, async () => {
    await accessOf(x, pid, "owner");
    const row = { pid, role, maxUses, uses: 0, createdBy: x.uid, createdAt: now(), expiresAt };
    out = { token, role, maxUses, expiresAt };
    return {
      writes: [createAt(x, J.paths.invite(token), row)],
      audit: [{ action: "invite.create", ref: `projects/${pid}`, after: { role, maxUses, expiresAt } }],   // the token is not logged
      result: null,
    };
  });
  return { invite: out };
}

// Anyone with a valid token joins. A repeat join changes nothing. Uses are counted atomically on the invite.
async function opInviteAccept(x) {
  await projSchemaReady(x);
  const token = x.p.token;
  if (typeof token !== "string" || !/^[a-z0-9]{24}$/.test(token)) throw new C.PfmError("bad_invite");
  let out = null;
  await commitAudited(x, async () => {
    const inv = await getDoc(x, J.paths.invite(token));
    if (!inv) throw new C.PfmError("bad_invite");
    const p = await getDoc(x, J.paths.project(inv.pid));
    if (!p) throw new C.PfmError("not_found", "project");
    const mine = await getDoc(x, J.paths.member(inv.pid, x.uid));
    if (mine) { out = { project: await presentProject(x, p), role: mine.role }; return { result: null }; }
    if (Date.parse(inv.expiresAt) < Date.now()) throw new C.PfmError("invite_expired");
    if (inv.uses >= inv.maxUses) throw new C.PfmError("invite_used");
    const at = now();
    out = { project: await presentProject(x, p), role: inv.role };
    return {
      writes: [
        updateAt(x, J.paths.invite(token), { uses: inv.uses + 1 }, ["uses"], inv._updateTime),
        createAt(x, J.paths.member(inv.pid, x.uid), { role: inv.role, displayName: memberName(x) ?? null, addedAt: at, addedBy: inv.createdBy }),
        createAt(x, J.paths.index(x.uid, inv.pid), { role: inv.role, createdAt: at }),
      ],
      audit: [{ action: "member.join", ref: `projects/${inv.pid}`, after: { role: inv.role } }],
      result: null,
    };
  });
  return { project: out.project, role: out.role };
}

// ---------- account deletion for projects ----------

// Called by the purge job. The user's index lists their projects. An owned project is deleted for everyone;
// a shared project only loses this user's membership. false = budget ran out (the job retries).
export async function purgeProjects(d, token, uid, spend) {
  for (;;) {
    if (!spend()) return false;
    const ixs = await d.fsList(token, J.paths.indexes(uid));
    if (!ixs.length) return true;
    for (const ix of ixs) {
      const pid = ix.name.split("/").pop();
      if (!spend()) return false;
      if (ix.fields?.role?.stringValue === "owner") {
        if (!(await dropProject(d, token, pid, spend))) return false;
      } else {
        await d.fsCommit(token, [{ delete: d.DOC_ROOT + "/" + J.paths.member(pid, uid) }, { delete: ix.name }]);
      }
    }
  }
}
