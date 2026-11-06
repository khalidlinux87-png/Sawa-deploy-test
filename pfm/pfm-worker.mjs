// Sawa Personal Accountant: Worker operations (phase P1: settings, categories, ledger, monthly rollups, audit).
// worker-3.js routes every "pfm.*" op here and passes its own Firestore helpers as `d`, so this file keeps
// the Worker's retry, token and path-safety behaviour and can be tested in Node against an in-memory Firestore.
//
// Every mutation is ONE Firestore commit: the row, the month rollup increments, and the audit entry together.
// The audit head carries an updateTime precondition, so two concurrent writes cannot fork the hash chain;
// the loser re-reads and retries.
import * as C from "./pfm-core.mjs";

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
  const cats = [...(await categoryMap(x)).values()].map(strip).sort((a, b) => a.order - b.order);
  return { settings: strip(s), categories: cats, today: C.localDate(s.tz), month: C.budgetMonth(C.localDate(s.tz), s.monthStartDay) };
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
    source: base?.source || "manual", status: "booked", deleted: false };
}

async function opTxAdd(x) {
  const p = x.p;
  if (!ID_RE.test(p.idemKey || "")) throw new C.PfmError("bad_idem_key");
  const id = "t_" + p.idemKey;            // the client's idempotency key IS the row id: a retry hits exists:false
  let out;
  await commitAudited(x, async () => {
    const existing = js(x, await x.d.fsGet(x.token, `pfm/${x.uid}/tx/${id}`));
    if (existing) { out = existing; return { result: null }; }
    const s = await settingsOf(x), cats = await categoryMap(x);
    const tx = { ...(await buildTx(x, s, cats, p, null)), rev: 1, createdAt: now(), updatedAt: now() };
    out = { id, ...tx };
    const writes = [{ update: { name: P(x, `pfm/${x.uid}/tx/${id}`), fields: fieldsOf(x, tx) }, currentDocument: { exists: false } },
      ...rollupWrites(x, C.rollupDiff(null, tx))];
    if (tx.fxSource === "manual") writes.push(fxLastWrite(x, tx, s.baseCurrency));
    if (!s.hasTx) writes.push({ update: { name: P(x, `pfm/${x.uid}`), fields: fieldsOf(x, { hasTx: true }) }, updateMask: { fieldPaths: ["hasTx"] } });
    return { writes, audit: [{ action: "tx.add", ref: `tx/${id}`, after: auditView(tx) }], result: null };
  });
  return { tx: await present(x, out) };
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
  if (x.p.rev !== old.rev) throw new C.PfmError("stale", "reload and try again");
  return old;
}

async function opTxUpdate(x) {
  let out;
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
    return { writes, audit: [{ action: "tx.update", ref: `tx/${old.id}`, before, after }], result: null };
  });
  return { tx: await present(x, out) };
}

async function opTxDelete(x) {
  await commitAudited(x, async () => {
    const old = await loadTxForEdit(x);
    const nx = { ...strip(old), deleted: true, rev: old.rev + 1, updatedAt: now() }; delete nx.id;
    return {
      writes: [{ update: { name: P(x, `pfm/${x.uid}/tx/${old.id}`), fields: fieldsOf(x, nx) }, currentDocument: { updateTime: old._updateTime } },
        ...rollupWrites(x, C.rollupDiff(old, nx))],
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
  for (const c of ["tx", "categories", "months", "fxLast", "recurring", "budgets"])
    if (!(await purgeColl(token, `pfm/${uid}/${c}`, spend))) return false;
  if (!(await purgeColl(token, `audit/${uid}/log`, spend))) return false;
  if (!spend()) return false;
  await d.fsCommit(token, [{ delete: d.DOC_ROOT + `/pfm/${uid}` }, { delete: d.DOC_ROOT + `/audit/${uid}` }]);
  return true;
}
