/* ============================================================
   worker.js — سوا · applyEdit (v2: التحقّق + الكتابة إلى Firestore)
   ------------------------------------------------------------
   يعمل على Cloudflare Workers (مجاناً).
   v2 يضيف: مفتاح خدمة → رمز وصول Google → الكتابة إلى Firestore.
   أوّل عمليّة: group.create (ينشئ العائلة وعضويّة المالك).

   يتطلّب سرّاً في Cloudflare اسمه SA_JSON = محتوى ملف مفتاح
   الخدمة (Service Account JSON) كاملاً.

   ⚠️ إن أُعيد إنشاء مشروع Firebase بمعرّفٍ جديد، غيّر PROJECT_ID.
   ============================================================ */

const VER = "v22-push";      // علامة الإصدار — تظهر في كلّ ردّ
const PROJECT_ID = "sawa-test-9770f";
const ISS = "https://securetoken.google.com/" + PROJECT_ID;
const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
// مسار المستند النسبيّ (يُستعمل في حقل name داخل الكتابة)
const DOC_ROOT = "projects/" + PROJECT_ID + "/databases/(default)/documents";
// الرابط الكامل (يُستعمل لاستدعاء الـAPI فقط)
const FS_BASE = "https://firestore.googleapis.com/v1/" + DOC_ROOT;
// Realtime Database (الحضور · «يكتب…» · إشارات المكالمات والغرف) — يكتب الـWorker فيها قوائم الصلاحيّة فقط
const RTDB_URL = "https://sawa-test-9770f-default-rtdb.europe-west1.firebasedatabase.app";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

/* ---------- base64 helpers ---------- */
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToB64url(s) { return bytesToB64url(new TextEncoder().encode(s)); }
function b64urlStr(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

/* ---------- 1) التحقّق من Firebase ID token ---------- */
let jwkCache = null, jwkAt = 0;
async function getKeys() {
  const now = Date.now();
  if (jwkCache && now - jwkAt < 3600000) return jwkCache;
  const data = await (await fetch(JWK_URL)).json();
  const map = {};
  for (const k of data.keys) map[k.kid] = k;
  jwkCache = map; jwkAt = now;
  return map;
}
async function verifyIdToken(token) {
  const p = token.split(".");
  if (p.length !== 3) throw new Error("bad token format");
  const header = JSON.parse(b64urlStr(p[0]));
  const payload = JSON.parse(b64urlStr(p[1]));
  if (header.alg !== "RS256") throw new Error("alg");
  const jwk = (await getKeys())[header.kid];
  if (!jwk) throw new Error("unknown kid");
  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(p[2]), new TextEncoder().encode(p[0] + "." + p[1]));
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error("aud mismatch");
  if (payload.iss !== ISS) throw new Error("iss mismatch");
  if (payload.exp < now) throw new Error("token expired");
  if (!payload.sub) throw new Error("no sub");
  return payload;
}

/* ---------- 2) رمز وصول من مفتاح الخدمة ---------- */
let saTokCache = null, saTokExp = 0;
function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return b64ToBytes(body);
}
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (saTokCache && now < saTokExp - 60) return saTokCache;
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    // رمزٌ واحد لكلّ الخدمات: Firestore + Realtime Database (+ الإشعارات لاحقاً)
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const unsigned = strToB64url(JSON.stringify(header)) + "." + strToB64url(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const jwt = unsigned + "." + bytesToB64url(sig);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("token mint failed: " + JSON.stringify(data));
  saTokCache = data.access_token;
  saTokExp = now + (data.expires_in || 3600);
  return saTokCache;
}

/* ---------- 3) الكتابة إلى Firestore (commit ذرّي) ---------- */
async function fsCommit(accessToken, writes) {
  const res = await fetch(FS_BASE + ":commit", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore: " + JSON.stringify(data));
  return data;
}

/* قراءة وثيقة واحدة — relPath مثل "groups/{gid}/members/{uid}" */
async function fsGet(accessToken, relPath) {
  const res = await fetch(FS_BASE + "/" + relPath, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) throw new Error("firestore get: " + JSON.stringify(data));
  return data; // فيه .fields
}
function fstr(doc, name) {
  return doc && doc.fields && doc.fields[name] ? doc.fields[name].stringValue : null;
}
function fbool(doc, name) {
  return doc && doc.fields && doc.fields[name] ? !!doc.fields[name].booleanValue : false;
}

/* قائمة مجموعةٍ كاملة (صفحاتٍ متتابعة) */
async function fsList(accessToken, collPath) {
  let out = [], pageToken = null, guard = 0;
  do {
    const url = FS_BASE + "/" + collPath + "?pageSize=300" +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const res = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
    if (res.status === 404) return out;
    const data = await res.json();
    if (!res.ok) throw new Error("firestore list: " + JSON.stringify(data));
    if (data.documents) out = out.concat(data.documents);
    pageToken = data.nextPageToken; guard++;
  } while (pageToken && guard < 10);
  return out;
}

/* قيمة Firestore REST → JS */
function fsToJs(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fsToJs);
  if ("mapValue" in v) { const o = {}, f = (v.mapValue && v.mapValue.fields) || {}; for (const k in f) o[k] = fsToJs(f[k]); return o; }
  return null;
}
/* استعلامٌ بمساواتين (لا يحتاج فهرساً مركّباً) */
async function fsQueryEq(accessToken, collectionId, eqs, limit) {
  const filters = Object.keys(eqs).map(k => ({ fieldFilter: { field: { fieldPath: k }, op: "EQUAL", value: { stringValue: eqs[k] } } }));
  const res = await fetch(FS_BASE + ":runQuery", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collectionId }],
      where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters: filters } }, limit: limit || 100 } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore query: " + JSON.stringify(data));
  return (data || []).filter(r => r.document).map(r => r.document);
}

/* استعلامٌ داخل مجموعةٍ فرعيّة (groups/{g}/relations…) — يقرأ ما يطابق فقط بدل القائمة كلّها.
   filters: [[field, "EQUAL"|"IN", value|array]] */
async function fsQuerySub(accessToken, parentRel, collectionId, filters, limit) {
  const fl = filters.map(([k, op, v]) => ({ fieldFilter: { field: { fieldPath: k }, op: op,
    value: op === "IN" ? { arrayValue: { values: v.map(x => ({ stringValue: x })) } } : { stringValue: v } } }));
  const res = await fetch(FS_BASE + "/" + parentRel + ":runQuery", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collectionId }],
      where: fl.length === 1 ? fl[0] : { compositeFilter: { op: "AND", filters: fl } }, limit: limit || 300 } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore query: " + JSON.stringify(data));
  return (data || []).filter(r => r.document).map(r => r.document);
}
/* عدّ وثائق مجموعةٍ فرعيّة: قراءةٌ واحدة لكلّ ١٠٠٠ بدل قراءة كلّ وثيقة */
async function fsCount(accessToken, parentRel, collectionId, eq) {
  const q = { from: [{ collectionId: collectionId }] };
  if (eq) q.where = { fieldFilter: { field: { fieldPath: eq[0] }, op: "EQUAL", value: toFsValue(eq[1]) } };
  const res = await fetch(FS_BASE + "/" + parentRel + ":runAggregationQuery", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: q, aggregations: [{ alias: "n", count: {} }] } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore count: " + JSON.stringify(data));
  const r = (data || []).find(x => x.result);
  const v = r && r.result.aggregateFields && r.result.aggregateFields.n;
  return v ? Number(v.integerValue || 0) : 0;
}
/* قصّ القيم قبل الحفظ: نصوصٌ ≤ ٢٠٠٠ حرف، قوائم ≤ ٥٠، عمقٌ ≤ ٤ — لا يملأ أحدٌ القاعدة بنصٍّ ضخم */
function capVal(v, d) {
  d = d || 0;
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) : v;
  if (Array.isArray(v)) return d >= 4 ? [] : v.slice(0, 50).map(x => capVal(x, d + 1));
  if (v && typeof v === "object") {
    if (d >= 4) return null;
    const o = {}; let n = 0;
    for (const k in v) { if (++n > 40) break; o[String(k).slice(0, 60)] = capVal(v[k], d + 1); }
    return o;
  }
  return v;
}

/* تحويل قيمة JS إلى صيغة Firestore REST */
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    const f = {}; for (const k in v) f[k] = toFsValue(v[k]);
    return { mapValue: { fields: f } };
  }
  return { stringValue: String(v) };
}

/* ---------- 4) العمليّة: group.create ---------- */
async function opGroupCreate(uid, payload, env, claims) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const gid = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = (payload && payload.name) ? String(payload.name).slice(0, 100) : "عائلتي";
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + gid,
      fields: { name: { stringValue: name }, ownerUid: { stringValue: uid },
                createdTs: { timestampValue: now } } } },
    { update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid,
      fields: Object.assign({ role: { stringValue: "owner" }, joinedTs: { timestampValue: now } }, memberIdFields(claims)) } },
    indexWrite(uid, gid, name, "owner", now),
  ]);
  return { groupId: gid, name: name };
}

/* ---------- 5) العمليّة: invite.create (owner/editor) ---------- */
async function opInviteCreate(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  // التحقّق من الدور: عضوٌ owner أو editor وحده يدعو
  const member = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const role = fstr(member, "role");
  if (role !== "owner" && role !== "editor")
    throw new Error("not a manager of this group");
  // الدور الممنوح: مشاهد افتراضياً؛ «محرّر» يمنحه المالك وحده
  const grant = (payload && payload.role === "editor") ? "editor" : "viewer";
  if (grant === "editor" && role !== "owner") throw new Error("only the owner can invite editors");
  const inviteToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(); // أسبوع
  const g = await fsGet(token, "groups/" + groupId);
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/invites/" + inviteToken,
      fields: { groupId: { stringValue: groupId }, createdBy: { stringValue: uid },
                role: { stringValue: grant }, createdTs: { timestampValue: now },
                expiresTs: { timestampValue: expires },
                groupName: { stringValue: fstr(g, "name") || "عائلتي" } } } },
  ]);
  return { token: inviteToken, groupId: groupId, role: grant, expiresTs: expires };
}

/* ---------- 6) العمليّة: invite.accept (أيّ مستخدم مُتحقَّق) ---------- */
async function opInviteAccept(uid, payload, env, claims) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const inviteToken = payload && payload.token;
  if (!inviteToken) throw new Error("invite token required");
  const invite = await fsGet(token, "invites/" + inviteToken);
  if (!invite) throw new Error("invite not found");
  const groupId = fstr(invite, "groupId");
  const invitedBy = fstr(invite, "createdBy") || "";
  const exp = invite.fields && invite.fields.expiresTs && invite.fields.expiresTs.timestampValue;
  if (exp && Date.parse(exp) < Date.now()) throw new Error("invite expired");
  const grant = fstr(invite, "role") === "editor" ? "editor" : "viewer";
  const g = await fsGet(token, "groups/" + groupId);
  if (!g || fbool(g, "deleted")) throw new Error("this family was deleted");
  const gname = fstr(g, "name") || fstr(invite, "groupName") || "عائلتي";
  const now = new Date().toISOString();
  // عضوٌ سلفاً؟ لا نُنزِل دوره — نرفعه فقط إن كانت الدعوة أعلى
  const existing = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const cur = existing ? fstr(existing, "role") : null;
  if (cur && (ROLE_RANK[cur] || 0) >= ROLE_RANK[grant]) {
    await fsCommit(token, [indexWrite(uid, groupId, gname, cur, now)]);
    return { groupId: groupId, role: cur, name: gname, already: true };
  }
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/members/" + uid,
      fields: Object.assign({ role: { stringValue: grant }, joinedTs: { timestampValue: now },
                invitedBy: { stringValue: invitedBy } }, memberIdFields(claims)) } },
    indexWrite(uid, groupId, gname, grant, now),
  ]);
  try { await famChatSync(token, groupId); } catch (e) {}
  return { groupId: groupId, role: grant, name: gname };
}

/* يتحقّق أنّ المستخدم محرِّر/مالك في العائلة */
async function requireEditor(token, groupId, uid) {
  const me = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const role = fstr(me, "role");
  if (role !== "owner" && role !== "editor") throw new Error("not allowed to edit");
  return role;
}

/* اسم العضو كما يظهر لأهله: من حساب Google (الاسم فقط، لا البريد). الضيف بلا اسم. */
function memberIdFields(claims) {
  const anon = !!(claims && claims.firebase && claims.firebase.sign_in_provider === "anonymous");
  const nm = !anon && claims && typeof claims.name === "string" ? claims.name.trim().slice(0, 60) : "";
  return { name: nm ? { stringValue: nm } : { nullValue: null }, anon: { booleanValue: anon } };
}

/* فهرس عائلات الحساب: accounts/{uid}/groups/{gid} — يكتبه الـWorker وحده،
   ويقرؤه الـWorker في my.groups (لا يحتاج تعديل قواعد الأمان). */
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
function indexWrite(uid, gid, name, role, now) {
  return { update: { name: DOC_ROOT + "/accounts/" + uid + "/groups/" + gid,
    fields: { name: { stringValue: String(name || "عائلتي") }, role: { stringValue: role },
              ts: { timestampValue: now } } } };
}

/* ---------- 7) العمليّة: person.set (حقليّ — الأحدث يفوز) ---------- */
async function opPersonSet(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  await requireEditor(token, groupId, uid);

  const fields = (payload && payload.fields) || {};
  // ⛔ الحالة الصحّية لا تُخزَّن على السيرفر (قرار الخصوصية)
  if ("healthStatus" in fields) throw new Error("healthStatus is not stored on server");
  // status_detail يشمل «مريض» — قرار خالد (٩ أكتوبر): يظهر لأعضاء العائلة ليطمئنّوا عليه
  // الحقول الفعليّة في التطبيق. ⛔ status_detail (الحالة الصحّية) و healthStatus
  // و photo (حجمها) لا تُخزَّن على الخادم أبداً — ليست في القائمة فتُتجاهَل.
  const ALLOWED = ["local_name", "gender", "kinship", "proximity", "birthYear", "birthday", "alive",
                   "death_date", "deathYear", "contacts", "phones", "notes", "motherId",
                   "status_detail", "noChildren"];

  const now = new Date().toISOString();
  let pid = payload.personId, creating = false;
  if (pid) {
    const ex = await fsGet(token, "groups/" + groupId + "/persons/" + pid);
    if (!ex) creating = true;
    else if (fbool(ex, "deleted")) {
      // ⛔ تعديلٌ مقابل حذف (قرار ④): لا يُطبَّق صامتاً — يُراجَع
      const rid = crypto.randomUUID();
      await fsCommit(token, [{ update: { name: DOC_ROOT + "/reviewQueue/" + rid,
        fields: { groupId: { stringValue: groupId }, kind: { stringValue: "edit_vs_delete" },
                  proposedBy: { stringValue: uid }, ts: { timestampValue: now }, status: { stringValue: "pending" },
                  detail: toFsValue({ personId: pid, fields: Object.keys(fields), values: fields,
                                      name: fstr(ex, "local_name") || "" }) } } }]);
      return { applied: false, queued: true, reviewId: rid, reason: "editing a deleted person" };
    }
  } else { pid = crypto.randomUUID(); creating = true; }

  const changed = [], updFields = {}, ftsSub = {};
  for (const k of ALLOWED) if (k in fields) { updFields[k] = toFsValue(capVal(fields[k])); ftsSub[k] = { timestampValue: now }; changed.push(k); }
  if (changed.length === 0 && !creating) throw new Error("no fields to set");

  // ترقيعٌ لا استبدال: updateMask يكتب الحقول المذكورة وحدها
  const mask = changed.slice();
  updFields.fts = { mapValue: { fields: ftsSub } };     // طابع آخر كتابةٍ لكلّ حقل
  for (const k of changed) mask.push("fts." + k);
  updFields.updatedTs = { timestampValue: now }; mask.push("updatedTs");
  if (creating) { updFields.deleted = { booleanValue: false }; updFields.createdTs = { timestampValue: now }; mask.push("deleted", "createdTs"); }

  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/persons/" + pid, fields: updFields },
      updateMask: { fieldPaths: mask } },
    // سجلّ خفيف
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/changelog/" + crypto.randomUUID(),
      fields: { ts: { timestampValue: now }, by: { stringValue: uid }, personId: { stringValue: pid },
                op: { stringValue: "person.set" }, changed: toFsValue(changed) } } },
  ]);
  return { personId: pid, created: creating, changed: changed };
}

/* ---------- 8) العمليّة: relation.add (بنيويّ — حارسٌ ثم مراجعة) ---------- */
async function opRelationAdd(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  await requireEditor(token, groupId, uid);

  const type = payload.type, from = payload.from, to = payload.to; // parent: from=الوالد, to=الابن
  if (["parent", "spouse", "ex_spouse", "sibling"].indexOf(type) < 0) throw new Error("bad relation type");
  if (!from || !to) throw new Error("from/to required");
  if (from === to) throw new Error("from equals to");

  // ⛔ لا نقرأ كلّ صلات العائلة (كانت تكلّف قراءةً لكلّ صلة في كلّ إضافة): استعلاماتٌ موجّهة فقط
  const gPath = "groups/" + groupId;
  const live = docs => docs.filter(d => !fbool(d, "deleted")).map(d => ({ type: fstr(d, "type"), from: fstr(d, "from"), to: fstr(d, "to") }));
  // احتياط: إن رفض Firestore الاستعلام (فهرسٌ ناقص مثلاً) نعود للطريقة القديمة — قائمةٌ كاملة مرّةً واحدة
  let all = null;
  const allRels = async () => all || (all = live(await fsList(token, gPath + "/relations")));
  const q = async (filters, lim, fallback) => {
    if (all) return fallback(all);
    try { return live(await fsQuerySub(token, gPath, "relations", filters, lim)); }
    catch (e) { return fallback(await allRels()); }
  };
  const same = await q([["from", "EQUAL", from], ["to", "EQUAL", to]], 20, A => A.filter(r => r.from === from && r.to === to));
  if (same.some(r => r.type === type)) return { applied: false, reason: "exists" };
  const parentsOf = (ids) => { const set = ids.slice(0, 30);
    return q([["type", "EQUAL", "parent"], ["to", "IN", set]], 200, A => A.filter(r => r.type === "parent" && set.indexOf(r.to) >= 0)); };

  let conflict = null;
  if (type === "parent") {
    // حارس مقعد الوالد بالجنس (v173): لا والدَين من نفس الجنس للابن
    const parent = await fsGet(token, "groups/" + groupId + "/persons/" + from);
    const pGender = fstr(parent, "gender");
    const existingParents = (await parentsOf([to])).map(r => r.from);
    for (const pp of existingParents) {
      const ppDoc = await fsGet(token, "groups/" + groupId + "/persons/" + pp);
      const g = fstr(ppDoc, "gender");
      if (g && pGender && g === pGender) { conflict = "parent slot of this gender already taken"; break; }
    }
    // حارس الدورات: لو كان الابن أصلاً من أسلاف الوالد → دورة
    // جيلاً بعد جيل (استعلامٌ واحد لكلّ جيل، ≤ ١٢ جيلاً — يبقى تحت حدّ ٥٠ طلباً فرعيّاً)
    if (!conflict) {
      const seen = new Set([from]); let gen = [from], depth = 0;
      while (gen.length && depth < 12 && !conflict) {
        const ps = (await parentsOf(gen)).map(r => r.from);
        const next = [];
        for (const p of ps) { if (p === to) { conflict = "cycle: child is an ancestor of parent"; break; } if (!seen.has(p)) { seen.add(p); next.push(p); } }
        gen = next.slice(0, 30); depth++;
      }
    }
  }

  const now = new Date().toISOString();
  if (conflict) {
    const rid = crypto.randomUUID();
    await fsCommit(token, [
      { update: { name: DOC_ROOT + "/reviewQueue/" + rid,
        fields: { groupId: { stringValue: groupId }, kind: { stringValue: "relation" },
                  proposedBy: { stringValue: uid }, ts: { timestampValue: now },
                  status: { stringValue: "pending" },
                  detail: toFsValue({ type: type, from: from, to: to, conflict: conflict,
                                      relationId: payload.relationId ? String(payload.relationId) : null }) } } },
    ]);
    return { applied: false, queued: true, reviewId: rid, reason: conflict };
  }

  // المعرّف المحلّيّ = معرّف الخادم (قرار §٨-١): استعمل relationId من العميل إن وُجد
  const relId = (payload.relationId && String(payload.relationId)) || crypto.randomUUID();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/relations/" + relId,
      fields: Object.assign({ type: { stringValue: type }, from: { stringValue: from }, to: { stringValue: to },
                createdTs: { timestampValue: now }, deleted: { booleanValue: false } },
                payload.inferred ? { inferred: { stringValue: String(payload.inferred) } } : {}) } },
  ]);
  return { applied: true, relationId: relId };
}

/* كتابةٌ على دفعاتٍ (حدّ Firestore 500 كتابة/طلب) */
async function commitChunks(token, writes) {
  for (let i = 0; i < writes.length; i += 400) await fsCommit(token, writes.slice(i, i + 400));
}

/* ---------- 9) العمليّة: review.resolve (editor يحسم مراجعة) ---------- */
async function opReviewResolve(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const reviewId = payload && payload.reviewId;
  const decision = payload && payload.decision; // "apply" | "reject"
  if (!reviewId) throw new Error("reviewId required");
  const review = await fsGet(token, "reviewQueue/" + reviewId);
  if (!review) throw new Error("review not found");
  const groupId = fstr(review, "groupId");
  await requireEditor(token, groupId, uid);
  if (fstr(review, "status") !== "pending")
    return { resolved: false, already: true, status: fstr(review, "status") };

  const now = new Date().toISOString();
  const closeReview = function (resolution) {
    return { update: { name: DOC_ROOT + "/reviewQueue/" + reviewId,
      fields: { status: { stringValue: "resolved" }, resolution: { stringValue: resolution },
                resolvedBy: { stringValue: uid }, resolvedTs: { timestampValue: now } } },
      updateMask: { fieldPaths: ["status", "resolution", "resolvedBy", "resolvedTs"] } };
  };

  if (decision === "reject") {
    await fsCommit(token, [closeReview("rejected")]);
    return { resolved: true, resolution: "rejected" };
  }
  if (decision === "apply") {
    const kind = fstr(review, "kind");
    if (kind === "relation") {
      const d = review.fields.detail && review.fields.detail.mapValue && review.fields.detail.mapValue.fields;
      if (!d) throw new Error("review detail missing");
      const type = d.type.stringValue, from = d.from.stringValue, to = d.to.stringValue;
      const relId = (d.relationId && d.relationId.stringValue) || crypto.randomUUID();
      // تطبيقٌ بقرار الإنسان، رغم التحذير — في نفس الـcommit مع إغلاق المراجعة
      await fsCommit(token, [
        { update: { name: DOC_ROOT + "/groups/" + groupId + "/relations/" + relId,
          fields: { type: { stringValue: type }, from: { stringValue: from }, to: { stringValue: to },
                    createdTs: { timestampValue: now }, deleted: { booleanValue: false },
                    fromReview: { stringValue: reviewId } } } },
        closeReview("applied"),
      ]);
      return { resolved: true, resolution: "applied", relationId: relId };
    }
    if (kind === "edit_vs_delete") {
      // قبول: يُستعاد الشخص المحذوف ويُطبَّق عليه التعديل المحجوز
      const dv = fsToJs(review.fields.detail) || {};
      const pid = dv.personId, vals = dv.values || {};
      if (!pid) throw new Error("review detail missing");
      const ALLOWED = ["local_name", "gender", "kinship", "proximity", "birthYear", "birthday", "alive",
                       "death_date", "deathYear", "contacts", "phones", "notes", "motherId", "status_detail", "noChildren"];
      const f = { deleted: { booleanValue: false }, updatedTs: { timestampValue: now } }, mask = ["deleted", "updatedTs"];
      for (const k of ALLOWED) if (k in vals) { f[k] = toFsValue(capVal(vals[k])); mask.push(k); }
      await fsCommit(token, [
        { update: { name: DOC_ROOT + "/groups/" + groupId + "/persons/" + pid, fields: f }, updateMask: { fieldPaths: mask } },
        closeReview("applied"),
      ]);
      return { resolved: true, resolution: "applied", personId: pid };
    }
    // أنواع أخرى (self_duplicate …) تُغلَق فقط، دون تطبيقٍ آليّ
    await fsCommit(token, [closeReview("acknowledged")]);
    return { resolved: true, resolution: "acknowledged", kind: kind };
  }
  throw new Error("decision must be apply or reject");
}

/* ---------- 10) العمليّة: bulk.import (المالك · الرفع الأوّل) ---------- */
async function opBulkImport(uid, payload, env, claims) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const now = new Date().toISOString();
  // ⛔ أمان: معرّف مجموعةٍ من العميل يُقبَل فقط لمجموعةٍ موجودة وهو محرّرٌ فيها (استبدالٌ في مكانها).
  // مجموعةٌ جديدة يولّد الخادم معرّفها دائماً — لا يصير أحدٌ مالكاً لمجموعةٍ بمعرفة معرّفها.
  let gid = crypto.randomUUID(), existing = false, myRole = "owner";
  if (payload && payload.groupId) {
    const gdoc = await fsGet(token, "groups/" + String(payload.groupId));
    if (gdoc) {
      myRole = await requireEditor(token, String(payload.groupId), uid);
      // استبدال الشجرة كلّها للمالك وحده (قرار خالد ١٠ أكتوبر) — المحرّر يعدّل شخصاً شخصاً
      if (myRole !== "owner") throw new Error("only the owner can replace the family");
      gid = String(payload.groupId); existing = true;
    }
  }
  const replace = existing && payload && payload.replace === true;
  const name = (payload && payload.name) ? String(payload.name).slice(0, 100) : "عائلتي";
  const persons = (payload && Array.isArray(payload.persons)) ? payload.persons : [];
  const relations = (payload && Array.isArray(payload.relations)) ? payload.relations : [];
  // سقفٌ يحمي حصّة الكتابة اليوميّة (٢٠ ألفاً) من رفعٍ واحدٍ ضخم
  if (persons.length > 3000 || relations.length > 6000) throw new Error("tree too large for one upload");
  // الحقول الفعليّة في التطبيق. ⛔ status_detail (الحالة الصحّية) و healthStatus
  // و photo (حجمها) لا تُخزَّن على الخادم أبداً — ليست في القائمة فتُتجاهَل.
  const ALLOWED = ["local_name", "gender", "kinship", "proximity", "birthYear", "birthday", "alive",
                   "death_date", "deathYear", "contacts", "phones", "notes", "motherId",
                   "status_detail", "noChildren"];

  // خريطة المعرّفات المحلّية → الخادم. مع حفظ المعرّفات: fid = lid (لا تبديل).
  const map = {}; let selfCount = 0; const personWrites = [];
  for (const p of persons) {
    const lid = (p.localId && segOk(String(p.localId))) ? String(p.localId) : crypto.randomUUID();
    const fid = lid; map[p.localId || lid] = fid;
    if (p.kinship === "نفسي") selfCount++;
    const f = { deleted: { booleanValue: false }, createdTs: { timestampValue: now }, updatedTs: { timestampValue: now } };
    const ftsSub = {};
    for (const k of ALLOWED) if (k in p) { f[k] = toFsValue(capVal(p[k])); ftsSub[k] = { timestampValue: now }; }
    // ⛔ healthStatus لا يُنسَخ (خارج ALLOWED) — لا يعبر القاعدة
    f.fts = { mapValue: { fields: ftsSub } };
    personWrites.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/persons/" + fid, fields: f } });
  }

  // إعادة تأصيل الصلات؛ ما سقط طرفه يُتخطّى
  let orphans = 0; const relWrites = [];
  for (const r of relations) {
    const from = map[r.fromLocalId], to = map[r.toLocalId];
    if (!from || !to) { orphans++; continue; }
    const rid = (r.localId && segOk(String(r.localId))) ? String(r.localId) : crypto.randomUUID();
    relWrites.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/relations/" + rid,
      fields: Object.assign({ type: { stringValue: r.type }, from: { stringValue: from }, to: { stringValue: to },
                createdTs: { timestampValue: now }, deleted: { booleanValue: false } },
                r.inferred ? { inferred: { stringValue: String(r.inferred) } } : {}) } });
  }

  // عائلةٌ جديدة: الوثيقة + المالك. موجودةٌ: لا نمسّ المالك ولا الأعضاء.
  if (!existing) {
    await fsCommit(token, [
      { update: { name: DOC_ROOT + "/groups/" + gid,
        fields: { name: { stringValue: name }, ownerUid: { stringValue: uid }, createdTs: { timestampValue: now } } } },
      { update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid,
        fields: Object.assign({ role: { stringValue: "owner" }, joinedTs: { timestampValue: now } }, memberIdFields(claims)) } },
      indexWrite(uid, gid, name, "owner", now),
    ]);
  } else {
    await fsCommit(token, [indexWrite(uid, gid, name, myRole, now)]);
  }
  // استبدال: ما في الخادم وليس في الشجرة المرفوعة يُوسَم محذوفاً (شاهدة، لا محو)
  let removedPersons = 0, removedRelations = 0;
  if (replace) {
    const keepP = {}; for (const w of personWrites) keepP[w.update.name.split("/").pop()] = 1;
    const keepR = {}; for (const w of relWrites) keepR[w.update.name.split("/").pop()] = 1;
    const tomb = [];
    for (const d of await fsList(token, "groups/" + gid + "/persons")) {
      const id = d.name.split("/").pop();
      if (!keepP[id] && !fbool(d, "deleted")) { removedPersons++;
        tomb.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/persons/" + id,
          fields: { deleted: { booleanValue: true }, deletedTs: { timestampValue: now }, deletedBy: { stringValue: uid } } },
          updateMask: { fieldPaths: ["deleted", "deletedTs", "deletedBy"] } }); }
    }
    for (const d of await fsList(token, "groups/" + gid + "/relations")) {
      const id = d.name.split("/").pop();
      if (!keepR[id] && !fbool(d, "deleted")) { removedRelations++;
        tomb.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/relations/" + id,
          fields: { deleted: { booleanValue: true }, deletedTs: { timestampValue: now } } },
          updateMask: { fieldPaths: ["deleted", "deletedTs"] } }); }
    }
    if (tomb.length) await commitChunks(token, tomb);
  }
  await commitChunks(token, personWrites);
  await commitChunks(token, relWrites);

  // ⛔ حارس «نفسي» المكرّر: لا يُحذف أحد، بل يُفتح بند مراجعة
  let selfDuplicate = false;
  if (selfCount > 1) {
    selfDuplicate = true;
    const rid = crypto.randomUUID();
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/reviewQueue/" + rid,
      fields: { groupId: { stringValue: gid }, kind: { stringValue: "self_duplicate" },
                proposedBy: { stringValue: uid }, ts: { timestampValue: now }, status: { stringValue: "pending" },
                detail: toFsValue({ count: selfCount, note: "multiple self on import" }) } } }]);
  }

  return { groupId: gid, personsImported: personWrites.length,
           relationsImported: relWrites.length, orphansSkipped: orphans, selfDuplicate: selfDuplicate,
           replaced: replace, existing: existing, removedPersons: removedPersons, removedRelations: removedRelations };
}

/* ---------- 11) العمليّة: person.delete (شاهدة) ---------- */
async function opPersonDelete(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  await requireEditor(token, groupId, uid);
  const pid = payload && payload.personId;
  if (!pid) throw new Error("personId required");
  const ex = await fsGet(token, "groups/" + groupId + "/persons/" + pid);
  if (!ex) throw new Error("person not found");
  const now = new Date().toISOString();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/persons/" + pid,
      fields: { deleted: { booleanValue: true }, deletedTs: { timestampValue: now }, deletedBy: { stringValue: uid } } },
      updateMask: { fieldPaths: ["deleted", "deletedTs", "deletedBy"] } },
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/changelog/" + crypto.randomUUID(),
      fields: { ts: { timestampValue: now }, by: { stringValue: uid }, personId: { stringValue: pid },
                op: { stringValue: "person.delete" } } } },
  ]);
  return { personId: pid, deleted: true };
}

/* ---------- 12) العمليّة: relation.remove (شاهدة) ---------- */
async function opRelationRemove(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  await requireEditor(token, groupId, uid);
  const relId = payload && payload.relationId;
  if (!relId) throw new Error("relationId required");
  const ex = await fsGet(token, "groups/" + groupId + "/relations/" + relId);
  if (!ex) throw new Error("relation not found");
  const now = new Date().toISOString();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/relations/" + relId,
      fields: { deleted: { booleanValue: true }, deletedTs: { timestampValue: now } } },
      updateMask: { fieldPaths: ["deleted", "deletedTs"] } },
  ]);
  return { relationId: relId, deleted: true };
}

/* ---------- 13) العمليّة: relation.update (تغيير نوع صلةٍ في مكانها — إنهاء الزواج §٨-٥) ---------- */
async function opRelationUpdate(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  await requireEditor(token, groupId, uid);
  const relId = payload && payload.relationId;
  if (!relId) throw new Error("relationId required");
  const type = payload && payload.type;
  if (["parent", "spouse", "ex_spouse", "sibling"].indexOf(type) < 0) throw new Error("bad relation type");
  const ex = await fsGet(token, "groups/" + groupId + "/relations/" + relId);
  if (!ex) throw new Error("relation not found");
  if (fbool(ex, "deleted")) throw new Error("relation is deleted");
  const now = new Date().toISOString();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/relations/" + relId,
      fields: { type: { stringValue: type }, updatedTs: { timestampValue: now } } },
      updateMask: { fieldPaths: ["type", "updatedTs"] } },
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/changelog/" + crypto.randomUUID(),
      fields: { ts: { timestampValue: now }, by: { stringValue: uid }, relationId: { stringValue: relId },
                op: { stringValue: "relation.update" }, newType: { stringValue: type } } } },
  ]);
  return { relationId: relId, type: type, updated: true };
}

/* ---------- 14) my.groups — عائلات هذا الحساب (من الفهرس) ---------- */
async function opMyGroups(uid, payload, env) {
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const docs = await fsList(token, "accounts/" + uid + "/groups");
  const out = [];
  for (const d of docs) {
    const gid = d.name.split("/").pop();
    // تحقّق حيّ من العضوية (قد تكون أُلغيت)
    const m = await fsGet(token, "groups/" + gid + "/members/" + uid);
    if (!m) continue;
    const g = await fsGet(token, "groups/" + gid);
    if (!g || fbool(g, "deleted")) continue;            // محذوفة
    // عدٌّ لا قراءة: (الكلّ − المحذوف) بقراءتين بدل قراءة كلّ شخص
    const personCount = Math.max(0, (await fsCount(token, "groups/" + gid, "persons")) - (await fsCount(token, "groups/" + gid, "persons", ["deleted", true])));
    const created = g.fields && g.fields.createdTs && g.fields.createdTs.timestampValue;
    out.push({ groupId: gid, name: fstr(g, "name") || fstr(d, "name") || "عائلتي", role: fstr(m, "role"),
               personCount: personCount, createdTs: created || null });
  }
  return { groups: out };
}

/* ---------- 15) account.index — يفهرس مجموعاتٍ عضوٌ فيها سلفاً (ترقيةٌ لما رُفع قبل v9) ---------- */
async function opAccountIndex(uid, payload, env) {
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const ids = (payload && Array.isArray(payload.groupIds)) ? payload.groupIds.slice(0, 50) : [];
  const now = new Date().toISOString(); const writes = []; const done = [];
  for (const gid of ids) {
    const m = await fsGet(token, "groups/" + gid + "/members/" + uid);
    if (!m) continue;                       // ليس عضواً ⇒ لا فهرسة
    const g = await fsGet(token, "groups/" + gid);
    writes.push(indexWrite(uid, gid, fstr(g, "name"), fstr(m, "role") || "viewer", now));
    done.push(gid);
  }
  if (writes.length) await fsCommit(token, writes);
  return { indexed: done };
}

/* ---------- 16) account.adopt — نقل عضويّات هويّةٍ سابقة (مجهولة) إلى الحالية ----------
   حين يرتبط حساب Google بهويّةٍ أخرى سلفاً، يدخل الجهاز بها؛ فيُقدِّم رمز هويّته
   القديمة (برهان امتلاكها) لتُنسَخ عضويّاتها إلى الهويّة الحاليّة بنفس الأدوار. */
async function opAccountAdopt(uid, payload, env, claims) {
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const fromToken = payload && payload.fromToken;
  if (!fromToken) throw new Error("fromToken required");
  const fromClaims = await verifyIdToken(fromToken);   // يثبت امتلاك الهويّة القديمة
  const fromUid = fromClaims.sub;
  if (fromUid === uid) return { adopted: [] };
  const ids = (payload && Array.isArray(payload.groupIds)) ? payload.groupIds.slice(0, 50) : [];
  const idx = await fsList(token, "accounts/" + fromUid + "/groups");
  for (const d of idx) { const gid = d.name.split("/").pop(); if (ids.indexOf(gid) < 0) ids.push(gid); }
  const now = new Date().toISOString(); const writes = []; const adopted = [];
  for (const gid of ids) {
    const old = await fsGet(token, "groups/" + gid + "/members/" + fromUid);
    if (!old) continue;
    const role = fstr(old, "role") || "viewer";
    const mine = await fsGet(token, "groups/" + gid + "/members/" + uid);
    const keep = mine && (ROLE_RANK[fstr(mine, "role")] || 0) >= (ROLE_RANK[role] || 0);
    const g = await fsGet(token, "groups/" + gid);
    if (!keep) writes.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid,
      fields: Object.assign({ role: { stringValue: role }, joinedTs: { timestampValue: now },
                adoptedFrom: { stringValue: fromUid } }, memberIdFields(claims)) } });
    writes.push(indexWrite(uid, gid, fstr(g, "name"), keep ? fstr(mine, "role") : role, now));
    // الهويّة القديمة لنفس الشخص: تُزال حتّى لا تظهر في «الأعضاء» عضواً ثانياً (أو مالكاً ثانياً)
    writes.push({ delete: DOC_ROOT + "/groups/" + gid + "/members/" + fromUid });
    writes.push({ delete: DOC_ROOT + "/accounts/" + fromUid + "/groups/" + gid });
    adopted.push(gid);
  }
  if (writes.length) await commitChunks(token, writes);
  return { adopted: adopted, fromUid: fromUid };
}

/* قيمة Firestore REST → JS (أرقام فقط لما نحتاجه هنا) */
function fsNum(v) {
  if (!v) return null;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  return null;
}

/* ---------- 17) contacts.sync — «آخر تواصل» الخاصّ بالمستخدم (بين أجهزته فقط) ----------
   accounts/{uid}/contacts/{gid} = { last: { personId: msTimestamp } }
   الدمج = الأحدث لكلّ شخص (لا يُمحى تواصلٌ سُجّل على أيّ جهاز). أيّ عضوٍ (حتّى المشاهد). */
async function opContactsSync(uid, payload, env) {
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  const m = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  if (!m) throw new Error("not a member");
  const incoming = (payload && payload.last && typeof payload.last === "object") ? payload.last : {};
  const doc = await fsGet(token, "accounts/" + uid + "/contacts/" + groupId);
  const cur = {};
  const lf = doc && doc.fields && doc.fields.last && doc.fields.last.mapValue && doc.fields.last.mapValue.fields;
  if (lf) for (const k in lf) { const n = fsNum(lf[k]); if (n) cur[k] = n; }
  let changed = 0; const merged = Object.assign({}, cur);
  for (const k in incoming) {
    const n = Number(incoming[k]);
    if (!n || !isFinite(n)) continue;
    if (!merged[k] || n > merged[k]) { merged[k] = n; changed++; }
  }
  if (changed) {
    const f = {}; for (const k in merged) f[k] = { integerValue: String(Math.round(merged[k])) };
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/accounts/" + uid + "/contacts/" + groupId,
      fields: { last: { mapValue: { fields: f } }, updatedTs: { timestampValue: new Date().toISOString() } } } }]);
  }
  return { last: merged, changed: changed };
}

/* ---------- 18) group.delete — المالك يحذف العائلة من الخادم ----------
   حذفٌ ناعم: تُوسَم العائلة محذوفة، وتُزال كلّ العضويّات وفهارسها ⇒ لا يقرؤها أحد بعدها
   (قواعد الأمان تشترط العضوية)، ولا تقبل روابط دعوتها. النسخ المحلّية على الأجهزة لا تُمسّ. */
async function opGroupDelete(uid, payload, env) {
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const gid = payload && payload.groupId;
  if (!gid) throw new Error("groupId required");
  const me = await fsGet(token, "groups/" + gid + "/members/" + uid);
  if (fstr(me, "role") !== "owner") throw new Error("only the owner can delete this family");
  const now = new Date().toISOString();
  const members = await fsList(token, "groups/" + gid + "/members");
  const writes = [{ update: { name: DOC_ROOT + "/groups/" + gid,
    fields: { deleted: { booleanValue: true }, deletedTs: { timestampValue: now }, deletedBy: { stringValue: uid } } },
    updateMask: { fieldPaths: ["deleted", "deletedTs", "deletedBy"] } }];
  for (const d of members) {
    const mu = d.name.split("/").pop();
    writes.push({ delete: d.name });
    writes.push({ delete: DOC_ROOT + "/accounts/" + mu + "/groups/" + gid });
  }
  await commitChunks(token, writes);
  try { await famChatSync(token, gid, []); } catch (e) {}
  return { groupId: gid, deleted: true, membersRemoved: members.length };
}

/* ---------- 19) group.leave — غير المالك يغادر العائلة ---------- */
async function opGroupLeave(uid, payload, env) {
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const gid = payload && payload.groupId;
  if (!gid) throw new Error("groupId required");
  const me = await fsGet(token, "groups/" + gid + "/members/" + uid);
  if (!me) return { groupId: gid, left: true };
  if (fstr(me, "role") === "owner") throw new Error("the owner can't leave — delete the family instead");
  await fsCommit(token, [
    { delete: DOC_ROOT + "/groups/" + gid + "/members/" + uid },
    { delete: DOC_ROOT + "/accounts/" + uid + "/groups/" + gid },
  ]);
  try { await famChatSync(token, gid); } catch (e) {}
  return { groupId: gid, left: true };
}

/* ---------- 20) review.list — المراجعات المعلّقة لعائلة (المالك والمحرّر) ---------- */
async function opReviewList(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  await requireEditor(token, groupId, uid);
  const docs = await fsQueryEq(token, "reviewQueue", { groupId: groupId, status: "pending" }, 100);
  const items = docs.map(d => ({ id: d.name.split("/").pop(), kind: fstr(d, "kind"),
    ts: d.fields && d.fields.ts && d.fields.ts.timestampValue, mine: fstr(d, "proposedBy") === uid,
    detail: fsToJs(d.fields && d.fields.detail) }));
  items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { items: items };
}

/* ---------- 21) photo.set — صورة شخص (مصغَّرة على الجهاز) في groups/{gid}/photos/{pid} ----------
   خدمة التخزين تتطلّب خطّة Blaze (محجوبة للسودان) ⇒ الصورة المصغَّرة نصّاً في Firestore. */
/* معرّفٌ آمن كجزءٍ من مسار Firestore: بلا «/» ولا «..» */
function segOk(x) { return typeof x === "string" && x.length > 0 && x.length <= 200 && x.indexOf("/") < 0 && x !== "." && x !== ".."; }
async function opPhotoSet(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const groupId = payload && payload.groupId, pid = payload && payload.personId;
  if (!segOk(groupId) || !segOk(pid)) throw new Error("groupId/personId required");
  await requireEditor(token, groupId, uid);
  const name = DOC_ROOT + "/groups/" + groupId + "/photos/" + pid;
  const data = payload.data;
  if (data == null) { await fsCommit(token, [{ delete: name }]); return { personId: pid, removed: true }; }
  const isUrl = typeof data === "string" && /^https:\/\/[^\s"'<>]+$/i.test(data) && data.length <= 2048;   // صورةٌ من الإنترنت: الرابط كما هو
  if (typeof data !== "string" || !(isUrl || /^data:image\/(jpeg|png|webp);base64,/.test(data))) throw new Error("bad image");
  if (data.length > 400000) throw new Error("image too large");
  await fsCommit(token, [{ update: { name: name, fields: { data: { stringValue: data },
    updatedTs: { timestampValue: new Date().toISOString() }, by: { stringValue: uid } } } }]);
  return { personId: pid, saved: true, size: data.length };
}

/* ---------- 22) event.set / event.delete — أحداث العائلة (مشتركة مع أعضائها) ---------- */
async function opEventSet(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const groupId = payload && payload.groupId, eid = payload && payload.eventId;
  if (!segOk(groupId) || !segOk(eid)) throw new Error("groupId/eventId required");
  await requireEventWriter(token, groupId, eid, uid);
  const fields = (payload && payload.fields) || {};
  const ALLOWED = ["personId", "type", "title", "desc", "dateTimestamp"];
  const f = { updatedTs: { timestampValue: new Date().toISOString() }, by: { stringValue: uid } };
  for (const k of ALLOWED) if (k in fields) f[k] = toFsValue(capVal(fields[k]));
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/groups/" + groupId + "/events/" + eid, fields: f } }]);
  return { eventId: eid, saved: true };
}
async function opEventDelete(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const groupId = payload && payload.groupId, eid = payload && payload.eventId;
  if (!segOk(groupId) || !segOk(eid)) throw new Error("groupId/eventId required");
  await requireEventWriter(token, groupId, eid, uid);
  await fsCommit(token, [{ delete: DOC_ROOT + "/groups/" + groupId + "/events/" + eid }]);
  return { eventId: eid, deleted: true };
}

/* محرّرٌ/مالك دائماً؛ والمشاهد إن سمح المالك (allowMemberEvents) — ويعدّل/يحذف ما أضافه هو فقط */
async function requireEventWriter(token, groupId, eid, uid) {
  const me = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const role = fstr(me, "role");
  if (role === "owner" || role === "editor") return role;
  if (!role) throw new Error("not a member of this family");
  const g = await fsGet(token, "groups/" + groupId);
  if (!fbool(g, "allowMemberEvents")) throw new Error("not allowed to edit");
  const ev = await fsGet(token, "groups/" + groupId + "/events/" + eid);
  if (ev && fstr(ev, "by") !== uid) throw new Error("you can only change events you added");
  return role;
}

/* ---------- 24) الأعضاء: member.hello · member.setRole · member.remove · group.settings ---------- */
// يحدّث اسم المستخدم في عائلاته (يتغيّر حين يربط حساب Google). لا يُنشئ عضويّة.
async function opMemberHello(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const ids = (payload && Array.isArray(payload.groupIds)) ? payload.groupIds.filter(segOk).slice(0, 30) : [];
  const want = memberIdFields(claims), writes = [], updated = [];
  for (const gid of ids) {
    const m = await fsGet(token, "groups/" + gid + "/members/" + uid);
    if (!m) continue;
    const curName = fstr(m, "name") || null, curAnon = fbool(m, "anon");
    const newName = want.name.stringValue || null, newAnon = want.anon.booleanValue;
    if (curName === newName && curAnon === newAnon && m.fields && "anon" in m.fields) continue;
    writes.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid, fields: want },
                  updateMask: { fieldPaths: ["name", "anon"] } });
    updated.push(gid);
  }
  if (writes.length) await fsCommit(token, writes);
  return { updated };
}
async function requireOwner(token, groupId, uid) {
  const me = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  if (fstr(me, "role") !== "owner") throw new Error("only the owner can manage members");
}
async function opMemberSetRole(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = payload && payload.groupId, target = payload && payload.uid, role = payload && payload.role;
  if (!segOk(gid) || !segOk(target)) throw new Error("groupId/uid required");
  if (role !== "editor" && role !== "viewer") throw new Error("role must be editor or viewer");
  await requireOwner(token, gid, uid);
  const m = await fsGet(token, "groups/" + gid + "/members/" + target);
  if (!m) throw new Error("not a member");
  if (fstr(m, "role") === "owner") throw new Error("the owner's role can't be changed");
  const g = await fsGet(token, "groups/" + gid);
  const now = new Date().toISOString();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + target, fields: { role: { stringValue: role } } },
      updateMask: { fieldPaths: ["role"] } },
    indexWrite(target, gid, fstr(g, "name"), role, now),
  ]);
  return { groupId: gid, uid: target, role };
}
async function opMemberRemove(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = payload && payload.groupId, target = payload && payload.uid;
  if (!segOk(gid) || !segOk(target)) throw new Error("groupId/uid required");
  await requireOwner(token, gid, uid);
  if (target === uid) throw new Error("the owner can't remove themselves");
  const m = await fsGet(token, "groups/" + gid + "/members/" + target);
  if (!m) return { groupId: gid, uid: target, removed: true };
  if (fstr(m, "role") === "owner") throw new Error("the owner can't be removed");
  await fsCommit(token, [
    { delete: DOC_ROOT + "/groups/" + gid + "/members/" + target },
    { delete: DOC_ROOT + "/accounts/" + target + "/groups/" + gid },
  ]);
  try { await famChatSync(token, gid); } catch (e) {}
  return { groupId: gid, uid: target, removed: true };
}
async function opGroupSettings(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = payload && payload.groupId;
  if (!segOk(gid)) throw new Error("groupId required");
  await requireOwner(token, gid, uid);
  const v = !!(payload && payload.allowMemberEvents);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/groups/" + gid, fields: { allowMemberEvents: { booleanValue: v } } },
                           updateMask: { fieldPaths: ["allowMemberEvents"] } }]);
  return { groupId: gid, allowMemberEvents: v };
}

/* ---------- 25) جهات الاتّصال: people.list · people.invite · people.accept · people.remove ----------
   جهة الاتّصال = من يشاركك عائلةً على السحابة + من أضفته برابطٍ شخصيّ (accounts/{uid}/people/{other}).
   people.list يكتب أيضاً قائمة الصلاحيّة في Realtime Database: acl/{أنا}/{هو} = true ⇒ يرى حضوري. */
async function rtdbPatch(token, updates) {
  const res = await fetch(RTDB_URL + "/.json?access_token=" + encodeURIComponent(token), {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) });
  if (!res.ok) throw new Error("rtdb: " + res.status + " " + (await res.text()).slice(0, 200));
}
async function peopleOf(token, uid, opts) {
  const people = {};   // uid -> { uid, name, anon, families:[{groupId,name}], via:{family,link} }
  const add = (u, name, anon, via, fam) => {
    if (!u || u === uid) return;
    const p = people[u] || (people[u] = { uid: u, name: null, anon: false, families: [], via: {} });
    if (name && !p.name) p.name = name;
    if (anon) p.anon = true; else if (name) p.anon = false;
    p.via[via] = true;
    if (fam && !p.families.some(f => f.groupId === fam.groupId)) p.families.push(fam);
  };
  const idx = (await fsList(token, "accounts/" + uid + "/groups")).slice(0, 20);
  for (const d of idx) {
    const gid = d.name.split("/").pop();
    const ms = await fsList(token, "groups/" + gid + "/members");
    if (!ms.some(m => m.name.split("/").pop() === uid)) continue;          // لم أعد عضواً
    const hidden = new Set(ms.map(m => fstr(m, "adoptedFrom")).filter(Boolean));   // هويّةٌ قديمة لنفس الشخص
    const fam = { groupId: gid, name: fstr(d, "name") || "عائلتي" };
    // حدّ ٥٠ طلباً فرعيّاً لكلّ طلب: نزامن محادثات أوّل ٦ عائلات فقط في كلّ استدعاء (والعضويّة تتحدّث أيضاً عند كلّ انضمام/إزالة)
    if (opts && opts.famChats && (opts.synced = (opts.synced || 0) + 1) <= 6) { try { await famChatSync(token, gid, ms); } catch (e) {} }
    for (const m of ms) { const u = m.name.split("/").pop(); if (!hidden.has(u)) add(u, fstr(m, "name"), fbool(m, "anon"), "family", fam); }
  }
  for (const d of await fsList(token, "accounts/" + uid + "/people")) add(d.name.split("/").pop(), fstr(d, "name"), fbool(d, "anon"), "link", null);
  return Object.values(people);
}
async function opPeopleList(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const list = await peopleOf(token, uid, { famChats: true });
  // الصلاحيّة: قائمتي كاملةً (من حُذف يفقد رؤية حضوري) + سطري عند كلٍّ منهم
  const updates = { ["acl/" + uid]: Object.fromEntries(list.map(p => [p.uid, true])) };
  for (const p of list) updates["acl/" + p.uid + "/" + uid] = true;
  let aclOk = true;
  try { await rtdbPatch(token, updates); } catch (e) { aclOk = false; }
  const me = memberIdFields(claims);
  return { me: { uid, name: me.name.stringValue || null, anon: me.anon.booleanValue },
           people: list.map(p => ({ uid: p.uid, name: p.name, anon: p.anon, families: p.families, via: Object.keys(p.via) })), acl: aclOk };
}
async function opPeopleInvite(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = crypto.randomUUID(), now = new Date(), exp = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const id = memberIdFields(claims);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/pinvites/" + t, fields: Object.assign({ uid: { stringValue: uid },
    createdTs: { timestampValue: now.toISOString() }, expiresTs: { timestampValue: exp.toISOString() } }, id) } }]);
  return { token: t, expiresTs: exp.toISOString() };
}
async function opPeopleAccept(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = payload && payload.token;
  if (!segOk(t)) throw new Error("token required");
  const inv = await fsGet(token, "pinvites/" + t);
  if (!inv) throw new Error("invite not found");
  const exp = inv.fields && inv.fields.expiresTs && inv.fields.expiresTs.timestampValue;
  if (exp && Date.parse(exp) < Date.now()) throw new Error("invite expired");
  const other = fstr(inv, "uid");
  if (!other) throw new Error("invite not found");
  if (other === uid) return { self: true };
  const now = new Date().toISOString(), mine = memberIdFields(claims);
  const theirs = { name: fstr(inv, "name") ? { stringValue: fstr(inv, "name") } : { nullValue: null }, anon: { booleanValue: fbool(inv, "anon") } };
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/accounts/" + uid + "/people/" + other, fields: Object.assign({ ts: { timestampValue: now } }, theirs) } },
    { update: { name: DOC_ROOT + "/accounts/" + other + "/people/" + uid, fields: Object.assign({ ts: { timestampValue: now } }, mine) } },
  ]);
  try { await rtdbPatch(token, { ["acl/" + uid + "/" + other]: true, ["acl/" + other + "/" + uid]: true }); } catch (e) {}
  return { uid: other, name: fstr(inv, "name") || null };
}
async function opPeopleRemove(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const other = payload && payload.uid;
  if (!segOk(other)) throw new Error("uid required");
  await fsCommit(token, [
    { delete: DOC_ROOT + "/accounts/" + uid + "/people/" + other },
    { delete: DOC_ROOT + "/accounts/" + other + "/people/" + uid },
  ]);
  return { uid: other, removed: true };   // إن بقيتما في عائلةٍ واحدة يبقى جهةَ اتّصال
}

/* ---------- 26) المحادثات (C2) ----------
   chats/{cid}: { type: family|dm|group|saved, members[], names{}, name, familyGroupId, createdTs, createdBy,
                  last{id,by,type,text,ts}, updatedTs, cnt, readCnt{uid:n}, reads{uid:ts}, delivered{uid:ts}, pinned, disappear }
   chats/{cid}/days/{YYYYMMDD}: { msgs: { [msgId]: رسالة } } — كلّ رسائل اليوم في وثيقةٍ واحدة (قراءةٌ واحدة لفتح المحادثة)،
   والتعديل حقلٌ بحقل (msgs.`id`.…) فلا يتعارض إرسالان متزامنان.
   المعرّفات: fam_<groupId> · dm_<uidأصغر>_<uidأكبر> · sv_<uid> · grp_<…> (C3). */
const fp = (...segs) => segs.map(s => "`" + String(s).replace(/`/g, "") + "`").join(".");
const MSG_ID = /^[A-Za-z0-9_]{6,40}$/;
const MEDIA_ID = /^[A-Za-z0-9_]{6,40}$/;
const MEDIA_TYPES = ["voice", "image", "video", "file"];
const MSG_TYPES = ["text", "sticker", "contact", "voice", "image", "video", "file", "poll", "bill", "fund", "tasks", "system"];
function dayKey(ms) { const d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); }
function dmId(a, b) { return "dm_" + [a, b].sort().join("_"); }
function fsInt(d, k) { const v = d && d.fields && d.fields[k]; return v ? Number(v.integerValue || v.doubleValue || 0) : 0; }
function fsArr(d, k) { const v = d && d.fields && d.fields[k]; return v && v.arrayValue && v.arrayValue.values ? v.arrayValue.values.map(x => x.stringValue) : []; }
async function chatDoc(token, cid) { return segOk(cid) ? fsGet(token, "chats/" + cid) : null; }
async function requireChatMember(token, cid, uid) {
  const c = await chatDoc(token, cid);
  if (!c || fbool(c, "deleted")) throw new Error("chat not found");
  if (fsArr(c, "members").indexOf(uid) < 0) throw new Error("not a member of this chat");
  return c;
}
async function rtdbSetChatMembers(token, cid, members) {
  try { await rtdbPatch(token, { ["chatm/" + cid]: members.length ? Object.fromEntries(members.map(u => [u, true])) : null }); } catch (e) {}
}
/* محادثة العائلة: أعضاؤها = أعضاء العائلة (بلا الهويّات القديمة). تُستدعى عند كلّ تغيّرٍ في العضويّة وفي people.list */
async function famChatSync(token, gid, knownMembers) {
  const g = await fsGet(token, "groups/" + gid);
  const ms = knownMembers || await fsList(token, "groups/" + gid + "/members");
  const hidden = new Set(ms.map(m => fstr(m, "adoptedFrom")).filter(Boolean));
  const live = (!g || fbool(g, "deleted")) ? [] : ms.filter(m => !hidden.has(m.name.split("/").pop()));
  const members = live.map(m => m.name.split("/").pop()).sort();
  const names = {}; live.forEach(m => { names[m.name.split("/").pop()] = fstr(m, "name") || null; });
  const cid = "fam_" + gid;
  const cur = await fsGet(token, "chats/" + cid);
  const sortObj = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
  const same = cur && JSON.stringify(fsArr(cur, "members").slice().sort()) === JSON.stringify(members)
    && sortObj(fsToJs((cur.fields || {}).names || { nullValue: null })) === sortObj(names)
    && fstr(cur, "name") === (fstr(g, "name") || "عائلتي");
  if (same) return { cid, changed: false };
  const fields = { type: { stringValue: "family" }, familyGroupId: { stringValue: gid }, name: { stringValue: fstr(g, "name") || "عائلتي" },
                   members: toFsValue(members), names: toFsValue(names) };
  const mask = ["type", "familyGroupId", "name", "members", "names"];
  if (!cur) { fields.createdTs = { integerValue: String(Date.now()) }; fields.updatedTs = { integerValue: String(Date.now()) }; fields.cnt = { integerValue: "0" }; mask.push("createdTs", "updatedTs", "cnt"); }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields }, updateMask: { fieldPaths: mask } }]);
  await rtdbSetChatMembers(token, cid, members);
  return { cid, changed: true };
}
async function sharesContact(token, a, b) {
  if (await fsGet(token, "accounts/" + a + "/people/" + b)) return true;
  const mine = (await fsList(token, "accounts/" + a + "/groups")).slice(0, 20);
  for (const d of mine) {
    const gid = d.name.split("/").pop();
    if (await fsGet(token, "groups/" + gid + "/members/" + b) && await fsGet(token, "groups/" + gid + "/members/" + a)) return true;
  }
  return false;
}
async function opChatOpen(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const now = Date.now(), me = memberIdFields(claims);
  if (payload && payload.saved) {
    const cid = "sv_" + uid;
    if (!(await fsGet(token, "chats/" + cid))) {
      await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { type: { stringValue: "saved" }, members: toFsValue([uid]),
        names: toFsValue({ [uid]: me.name.stringValue || null }), createdTs: { integerValue: String(now) }, updatedTs: { integerValue: String(now) }, cnt: { integerValue: "0" } } },
        currentDocument: { exists: false } }]).catch(() => {});
      await rtdbSetChatMembers(token, cid, [uid]);
    }
    return { cid };
  }
  const to = payload && payload.to;
  if (!segOk(to) || to === uid) throw new Error("to required");
  const cid = dmId(uid, to);
  const cur = await fsGet(token, "chats/" + cid);
  if (cur) return { cid };
  if (!(await sharesContact(token, uid, to))) throw new Error("not a contact");
  const other = await fsGet(token, "accounts/" + uid + "/people/" + to);
  let otherName = other ? fstr(other, "name") : null;
  if (!otherName) {   // من عائلةٍ مشتركة: الاسم من وثيقة العضو
    for (const d of (await fsList(token, "accounts/" + uid + "/groups")).slice(0, 20)) {
      const m = await fsGet(token, "groups/" + d.name.split("/").pop() + "/members/" + to); if (m && fstr(m, "name")) { otherName = fstr(m, "name"); break; }
    }
  }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { type: { stringValue: "dm" }, members: toFsValue([uid, to].sort()),
    names: toFsValue({ [uid]: me.name.stringValue || null, [to]: otherName || null }), createdTs: { integerValue: String(now) }, createdBy: { stringValue: uid },
    updatedTs: { integerValue: String(now) }, cnt: { integerValue: "0" } } }, currentDocument: { exists: false } }]).catch(() => {});
  await rtdbSetChatMembers(token, cid, [uid, to]);
  return { cid };
}
function cleanMsg(m, uid, ts) {
  if (!m || !MSG_ID.test(String(m.id || ""))) throw new Error("bad message id");
  const type = MSG_TYPES.indexOf(m.type) >= 0 ? m.type : "text";
  if (type === "system") throw new Error("bad type");
  const out = { id: m.id, by: uid, ts: ts, type: type };
  if (m.text != null) out.text = String(m.text).slice(0, type === "sticker" ? 16 : 4000);
  if (m.reply && MSG_ID.test(String(m.reply.id || ""))) out.reply = { id: m.reply.id, by: segOk(String(m.reply.by || "")) ? m.reply.by : null, text: String(m.reply.text || "").slice(0, 200) };
  if (m.fwd) out.fwd = true;
  if (type === "contact" && m.contact && segOk(String(m.contact.uid || ""))) out.contact = { uid: m.contact.uid, name: String(m.contact.name || "").slice(0, 80) };
  if (Array.isArray(m.mentions)) out.mentions = m.mentions.filter(x => segOk(String(x))).slice(0, 50);
  if (m.extra && typeof m.extra === "object") {
    // الصورة المصغّرة (≤ ٦٠٠٠ حرف) تُستثنى من قصّ النصوص — بقيّة الحقول تمرّ بـcapVal
    const thumb = typeof m.extra.thumb === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(m.extra.thumb) && m.extra.thumb.length <= 6000 ? m.extra.thumb : null;
    const rest = Object.assign({}, m.extra); delete rest.thumb;
    out.extra = capVal(rest);
    if (thumb) out.extra.thumb = thumb;
    if (MEDIA_TYPES.indexOf(type) >= 0 && !MEDIA_ID.test(String(out.extra.mid || ""))) throw new Error("media id required");
  }
  if (MEDIA_TYPES.indexOf(type) >= 0 && !(out.extra && out.extra.mid)) throw new Error("media id required");
  if (out.text === undefined && type === "text") throw new Error("empty message");
  return out;
}
function previewOf(msg) {
  if (msg.type === "text" || msg.type === "sticker") return (msg.text || "").slice(0, 120);
  return "";   // العميل يترجم النوع (🎤 رسالة صوتيّة…)
}
async function opChatSend(uid, payload, env, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  const type = fstr(c, "type");
  if (type === "dm") {   // الحظر: الطرف الآخر حظرني ⇒ لا تصل (ولا نخبر المرسل — كما في واتساب تبقى ✓ واحدة)
    const other = fsArr(c, "members").find(x => x !== uid);
    const pr = await fsGet(token, "accounts/" + other + "/chatprefs/main");
    const blocked = pr && fstr(pr, "data") ? (JSON.parse(fstr(pr, "data")).blocked || []) : [];
    if (blocked.indexOf(uid) >= 0) return { ts: Date.now(), day: null, blocked: true };
  }
  if (type === "group" && fbool(c, "adminsOnly")) {
    if (fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can send here");
  }
  const ts = Date.now(), day = dayKey(ts);
  const msg = cleanMsg(payload.msg, uid, ts);
  if (msg.extra && msg.extra.mid) {   // الوسيط رفعه المرسل نفسه في هذه المحادثة واكتمل
    const meta = await fsGet(token, "chats/" + cid + "/media/" + msg.extra.mid);
    if (!meta || fstr(meta, "by") !== uid || !fbool(meta, "done")) throw new Error("media not uploaded");
    msg.extra.size = fsInt(meta, "size"); msg.extra.mime = fstr(meta, "mime") || msg.extra.mime || null;
  }
  const dis = fsInt(c, "disappear");
  if (dis > 0) msg.exp = ts + dis * 1000;
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [msg.id]: toFsValue(msg) } } } } },
      updateMask: { fieldPaths: [fp("msgs", msg.id)] } },
    { update: { name: DOC_ROOT + "/chats/" + cid, fields: {
        last: toFsValue({ id: msg.id, by: uid, type: msg.type, text: previewOf(msg), ts: ts, day: day }),
        updatedTs: { integerValue: String(ts) },
        reads: { mapValue: { fields: { [uid]: { integerValue: String(ts) } } } },
        delivered: { mapValue: { fields: { [uid]: { integerValue: String(ts) } } } } } },
      updateMask: { fieldPaths: ["last", "updatedTs", fp("reads", uid), fp("delivered", uid)] },
      updateTransforms: [{ fieldPath: "cnt", increment: { integerValue: "1" } }, { fieldPath: fp("readCnt", uid), increment: { integerValue: "1" } }],
      currentDocument: { exists: true } },
  ]);
  // الإشعارات بعد الردّ (waitUntil) فلا ينتظرها المرسل
  const job = notifyChat(token, c, cid, uid, msg).catch(e => console.log("push:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return { ts, day, id: msg.id };
}
async function dayMsg(token, cid, day, id) {
  if (!/^\d{8}$/.test(String(day || "")) || !MSG_ID.test(String(id || ""))) throw new Error("bad message ref");
  const d = await fsGet(token, "chats/" + cid + "/days/" + day);
  const v = d && d.fields && d.fields.msgs && d.fields.msgs.mapValue.fields && d.fields.msgs.mapValue.fields[id];
  if (!v) throw new Error("message not found");
  return fsToJs(v);
}
/* ---------- الوسائط (C4): chats/{cid}/media/{mid} (وصف) + media/{mid}/c/{i} (قطع base64 ≤ ٧٠٠ ألف حرف)
   يكتبها الجهاز مباشرةً (قواعد Firestore: عضوٌ ومالكها)، ويحذفها الخادم: حذفٌ للجميع · مشاهدة مرّة · انتهاء الأجل. */
async function deleteMedia(token, cid, mid) {
  if (!MEDIA_ID.test(String(mid || ""))) return 0;
  const base = "chats/" + cid + "/media/" + mid;
  const chunks = await fsList(token, base + "/c");
  const writes = chunks.map(d => ({ delete: d.name })).concat([{ delete: DOC_ROOT + "/" + base }]);
  await commitChunks(token, writes);
  return chunks.length;
}
async function opMediaViewed(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, day, id } = payload || {};
  const c = await requireChatMember(token, cid, uid);
  const m = await dayMsg(token, cid, day, id);
  if (!m.extra || !m.extra.viewOnce) throw new Error("not a view-once message");
  if (m.by === uid) return { ok: true };
  const viewed = Object.assign({}, m.viewed || {}); viewed[uid] = Date.now();
  const others = fsArr(c, "members").filter(u => u !== m.by);
  const all = others.every(u => viewed[u]);
  const f = { viewed: { mapValue: { fields: { [uid]: { integerValue: String(viewed[uid]) } } } } }, mask = [fp("msgs", id, "viewed", uid)];
  if (all) { f.gone = { booleanValue: true }; mask.push(fp("msgs", id, "gone")); }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: f } } } } } } },
    updateMask: { fieldPaths: mask } }]);
  if (all) await deleteMedia(token, cid, m.extra.mid);   // شاهده الجميع ⇒ يُحذف الوسيط نهائيّاً
  return { gone: all };
}
async function opChatEdit(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, day, id } = payload || {};
  await requireChatMember(token, cid, uid);
  const m = await dayMsg(token, cid, day, id);
  if (m.by !== uid) throw new Error("only the sender can edit");
  if (m.del) throw new Error("message deleted");
  const text = String((payload && payload.text) || "").slice(0, 4000);
  if (!text.trim()) throw new Error("empty message");
  const now = Date.now();
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day,
    fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { text: { stringValue: text }, edited: { integerValue: String(now) } } } } } } } } },
    updateMask: { fieldPaths: [fp("msgs", id, "text"), fp("msgs", id, "edited")] } }]);
  return { edited: now };
}
async function opChatDelete(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, day, id } = payload || {};
  const c = await requireChatMember(token, cid, uid);
  const m = await dayMsg(token, cid, day, id);
  const admin = fstr(c, "type") === "group" && fsArr(c, "admins").indexOf(uid) >= 0;
  if (m.by !== uid && !admin) throw new Error("only the sender can delete for everyone");
  if (m.extra && m.extra.mid) { try { await deleteMedia(token, cid, m.extra.mid); } catch (e) {} }
  // الحذف للجميع: يبقى أثرٌ «حُذفت هذه الرسالة» بلا محتوى (والوسائط تُحذف في C4)
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day,
    fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { del: { booleanValue: true }, delBy: { stringValue: uid } } } } } } } } },
    updateMask: { fieldPaths: [fp("msgs", id, "del"), fp("msgs", id, "delBy"), fp("msgs", id, "text"), fp("msgs", id, "extra"), fp("msgs", id, "reply"), fp("msgs", id, "contact"), fp("msgs", id, "re")] } }]);
  const lastId = c.fields.last && c.fields.last.mapValue && c.fields.last.mapValue.fields && c.fields.last.mapValue.fields.id && c.fields.last.mapValue.fields.id.stringValue;
  if (lastId === id) await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { last: { mapValue: { fields: { del: { booleanValue: true }, text: { stringValue: "" } } } } } },
    updateMask: { fieldPaths: ["last.del", "last.text"] } }]);
  return { deleted: true };
}
async function opChatReact(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, day, id } = payload || {};
  await requireChatMember(token, cid, uid);
  if (!/^\d{8}$/.test(String(day || "")) || !MSG_ID.test(String(id || ""))) throw new Error("bad message ref");
  const emoji = payload.emoji ? String(payload.emoji).slice(0, 16) : null;
  const f = emoji ? { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { re: { mapValue: { fields: { [uid]: { stringValue: emoji } } } } } } } } } } } : {};
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: f },
    updateMask: { fieldPaths: [fp("msgs", id, "re", uid)] }, currentDocument: { exists: true } }]);
  return { ok: true };
}
async function opChatPin(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  await requireChatMember(token, cid, uid);
  const id = payload.id && MSG_ID.test(String(payload.id)) ? String(payload.id) : null;
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { pinned: id ? { stringValue: id } : { nullValue: null } } }, updateMask: { fieldPaths: ["pinned"] } }]);
  return { pinned: id };
}
// «وصلت/قُرئت»: كلّ مستخدمٍ يكتب حقوله فقط (delivered.me · reads.me · readCnt.me). حتّى ٣٠ محادثة في طلبٍ واحد.
async function opChatMark(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const marks = (payload && Array.isArray(payload.marks)) ? payload.marks.slice(0, 30) : [];
  const writes = [];
  for (const mk of marks) {
    if (!mk || !segOk(String(mk.cid || ""))) continue;
    const fields = {}, mask = [];
    if (Number.isFinite(mk.d)) { fields.delivered = { mapValue: { fields: { [uid]: { integerValue: String(Math.floor(mk.d)) } } } }; mask.push(fp("delivered", uid)); }
    if (Number.isFinite(mk.r)) { fields.reads = { mapValue: { fields: { [uid]: { integerValue: String(Math.floor(mk.r)) } } } }; mask.push(fp("reads", uid)); }
    if (Number.isFinite(mk.rc)) { fields.readCnt = { mapValue: { fields: { [uid]: { integerValue: String(Math.floor(mk.rc)) } } } }; mask.push(fp("readCnt", uid)); }
    if (mask.length) writes.push({ update: { name: DOC_ROOT + "/chats/" + mk.cid, fields }, updateMask: { fieldPaths: mask }, currentDocument: { exists: true } });
  }
  // ⛔ لا نتحقّق من العضويّة هنا (تكلّف قراءةً لكلّ محادثة): الكاتب لا يكتب إلّا حقول نفسه، والمحادثة يجب أن توجد
  for (const w of writes) { try { await fsCommit(token, [w]); } catch (e) {} }
  return { marked: writes.length };
}
async function opChatSettings(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  if (fstr(c, "type") === "group" && fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can change this");
  const allowed = [0, 3600, 86400, 604800, 7776000];
  const dis = Number(payload.disappear || 0);
  if (allowed.indexOf(dis) < 0) throw new Error("bad value");
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { disappear: { integerValue: String(dis) }, disappearBy: { stringValue: uid } } }, updateMask: { fieldPaths: ["disappear", "disappearBy"] } }]);
  return { disappear: dis };
}
// إعداداتي في المحادثات تتزامن بين أجهزتي: أرشفة، تثبيت، كتم، قفل، مجلّدات، سمات، نغمات، مميّزة، محذوفة عندي، محظورون
const PREF_KEYS = ["archived", "pinned", "muted", "locked", "folders", "folderOf", "themes", "tones", "starred", "hidden", "blocked", "drafts", "cleared", "broadcasts"];
async function opChatPrefs(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const path = "accounts/" + uid + "/chatprefs/main";
  const cur = await fsGet(token, path);
  let data = {}; try { data = cur && fstr(cur, "data") ? JSON.parse(fstr(cur, "data")) : {}; } catch (e) { data = {}; }
  const set = payload && payload.set;
  if (set && typeof set === "object") {
    if ("muted" in set) await syncMutedBy(token, uid, data.muted, set.muted);
    for (const k of PREF_KEYS) if (k in set) data[k] = capVal(set[k]);
    const json = JSON.stringify(data);
    if (json.length > 200000) throw new Error("prefs too large");
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/" + path, fields: { data: { stringValue: json }, ts: { integerValue: String(Date.now()) } } } }]);
  }
  return { prefs: data };
}
/* تنظيف الرسائل المؤقّتة (Cron كلّ ١٥ دقيقة): محادثاتٌ فيها disappear > 0 ⇒ يُحذف ما انتهى أجله */
async function cleanupDisappearing(env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "chats" }], where: { fieldFilter: { field: { fieldPath: "disappear" }, op: "GREATER_THAN", value: { integerValue: "0" } } }, limit: 10 } }) });
  const rows = (await res.json() || []).filter(r => r.document).map(r => r.document);
  const now = Date.now(); let removed = 0;
  for (const c of rows) {
    const cid = c.name.split("/").pop(), dis = fsInt(c, "disappear");
    const days = await fsList(token, "chats/" + cid + "/days");
    for (const d of days) {
      const key = d.name.split("/").pop();
      const dayEnd = Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8)) + 86400000;
      const msgs = (d.fields && d.fields.msgs && d.fields.msgs.mapValue.fields) || {};
      const mediaOf = ids => ids.map(id => { const m = fsToJs(msgs[id]); return m && m.extra && m.extra.mid; }).filter(Boolean);
      if (dayEnd + dis * 1000 < now) {
        for (const mid of mediaOf(Object.keys(msgs)).slice(0, 5)) { try { await deleteMedia(token, cid, mid); } catch (e) {} }
        await fsCommit(token, [{ delete: d.name }]); continue;
      }
      const gone = Object.keys(msgs).filter(id => { const m = fsToJs(msgs[id]); return m && m.exp && m.exp < now; });
      for (const mid of mediaOf(gone).slice(0, 5)) { try { await deleteMedia(token, cid, mid); } catch (e) {} }
      if (gone.length) { await fsCommit(token, [{ update: { name: d.name, fields: {} }, updateMask: { fieldPaths: gone.map(id => fp("msgs", id)) } }]); removed += gone.length; }
    }
  }
  return { chats: rows.length, removed };
}

/* ---------- 27) المجموعات (C3) ----------
   grp_<id>: { type: "group", name, desc, members[], admins[], names{}, adminsOnly, infoAdminsOnly, createdBy, createdTs, … }
   رسائل النظام (type: "system"): extra.ev = created|added|removed|left|joined|admin|unadmin|renamed|desc|adminsOnly */
async function contactSet(token, uid) {
  const list = await peopleOf(token, uid);
  const m = {}; list.forEach(p => { m[p.uid] = p.name || null; });
  return m;
}
async function sysMsg(token, cid, uid, ev, extra) {
  const ts = Date.now(), day = dayKey(ts), id = "s" + ts.toString(36) + Math.random().toString(36).slice(2, 7);
  const msg = { id, by: uid, ts, type: "system", extra: Object.assign({ ev }, extra || {}) };
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [id]: toFsValue(msg) } } } } }, updateMask: { fieldPaths: [fp("msgs", id)] } },
    { update: { name: DOC_ROOT + "/chats/" + cid, fields: { last: toFsValue({ id, by: uid, type: "system", text: "", ts, day, ev }), updatedTs: { integerValue: String(ts) } } },
      updateMask: { fieldPaths: ["last", "updatedTs"] }, currentDocument: { exists: true } },
  ]);
}
async function requireGroupAdmin(token, cid, uid) {
  const c = await requireChatMember(token, cid, uid);
  if (fstr(c, "type") !== "group") throw new Error("not a group");
  if (fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can do this");
  return c;
}
async function writeMembers(token, cid, members, admins, names) {
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { members: toFsValue(members), admins: toFsValue(admins), names: toFsValue(names) } },
    updateMask: { fieldPaths: ["members", "admins", "names"] }, currentDocument: { exists: true } }]);
  await rtdbSetChatMembers(token, cid, members);
}
async function opGroupCreate2(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const name = String((payload && payload.name) || "").trim().slice(0, 80);
  if (!name) throw new Error("name required");
  const want = Array.isArray(payload.members) ? payload.members.filter(x => segOk(String(x)) && x !== uid).slice(0, 100) : [];
  const contacts = await contactSet(token, uid);
  const members = [uid].concat(want.filter(u => u in contacts));
  const names = { [uid]: memberIdFields(claims).name.stringValue || null };
  members.forEach(u => { if (u !== uid) names[u] = contacts[u]; });
  const cid = "grp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20), now = Date.now();
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: {
    type: { stringValue: "group" }, name: { stringValue: name }, desc: { stringValue: String(payload.desc || "").slice(0, 500) },
    members: toFsValue(members), admins: toFsValue([uid]), names: toFsValue(names), createdBy: { stringValue: uid },
    createdTs: { integerValue: String(now) }, updatedTs: { integerValue: String(now) }, cnt: { integerValue: "0" }, adminsOnly: { booleanValue: false } } },
    currentDocument: { exists: false } }]);
  await rtdbSetChatMembers(token, cid, members);
  await sysMsg(token, cid, uid, "created", { name });
  return { cid, members, skipped: want.filter(u => !(u in contacts)) };
}
async function opGroupUpdate(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  if (fstr(c, "type") !== "group") throw new Error("not a group");
  const isAdmin = fsArr(c, "admins").indexOf(uid) >= 0;
  const fields = {}, mask = [];
  if (payload.name != null || payload.desc != null) {
    if (fbool(c, "infoAdminsOnly") && !isAdmin) throw new Error("only admins can do this");
    if (payload.name != null) { const n = String(payload.name).trim().slice(0, 80); if (!n) throw new Error("name required"); fields.name = { stringValue: n }; mask.push("name"); }
    if (payload.desc != null) { fields.desc = { stringValue: String(payload.desc).slice(0, 500) }; mask.push("desc"); }
  }
  for (const k of ["adminsOnly", "infoAdminsOnly"]) if (k in payload) {
    if (!isAdmin) throw new Error("only admins can do this");
    fields[k] = { booleanValue: !!payload[k] }; mask.push(k);
  }
  if (!mask.length) return { ok: true };
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields }, updateMask: { fieldPaths: mask } }]);
  if (fields.name) await sysMsg(token, cid, uid, "renamed", { name: fields.name.stringValue });
  if (fields.desc) await sysMsg(token, cid, uid, "desc", {});
  if ("adminsOnly" in fields) await sysMsg(token, cid, uid, "adminsOnly", { on: fields.adminsOnly.booleanValue });
  return { ok: true };
}
async function opGroupMembers(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireGroupAdmin(token, cid, uid);
  let members = fsArr(c, "members"), admins = fsArr(c, "admins");
  const names = fsToJs((c.fields || {}).names || { nullValue: null }) || {};
  const add = Array.isArray(payload.add) ? payload.add.filter(x => segOk(String(x))).slice(0, 50) : [];
  const remove = Array.isArray(payload.remove) ? payload.remove.filter(x => segOk(String(x)) && x !== uid).slice(0, 50) : [];
  let added = [];
  if (add.length) {
    const contacts = await contactSet(token, uid);
    added = add.filter(u => (u in contacts) && members.indexOf(u) < 0);
    added.forEach(u => { members.push(u); names[u] = contacts[u]; });
  }
  const removed = remove.filter(u => members.indexOf(u) >= 0);
  members = members.filter(u => removed.indexOf(u) < 0); admins = admins.filter(u => removed.indexOf(u) < 0);
  if (!added.length && !removed.length) return { added, removed };
  await writeMembers(token, cid, members, admins, names);
  if (added.length) await sysMsg(token, cid, uid, "added", { who: added });
  if (removed.length) await sysMsg(token, cid, uid, "removed", { who: removed });
  return { added, removed };
}
async function opGroupAdmin(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid, target = payload && payload.uid;
  const c = await requireGroupAdmin(token, cid, uid);
  const members = fsArr(c, "members"); let admins = fsArr(c, "admins");
  if (members.indexOf(target) < 0) throw new Error("not a member");
  const make = !!payload.admin;
  if (make && admins.indexOf(target) < 0) admins.push(target);
  if (!make) { admins = admins.filter(u => u !== target); if (!admins.length) throw new Error("a group needs at least one admin"); }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { admins: toFsValue(admins) } }, updateMask: { fieldPaths: ["admins"] } }]);
  await sysMsg(token, cid, uid, make ? "admin" : "unadmin", { who: [target] });
  return { admins };
}
async function opGroupLeave2(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  if (fstr(c, "type") !== "group") throw new Error("not a group");
  const members = fsArr(c, "members").filter(u => u !== uid);
  let admins = fsArr(c, "admins").filter(u => u !== uid);
  if (!admins.length && members.length) admins = [members[0]];   // المشرف الأخير يغادر ⇒ أقدم عضو يصير مشرفاً
  const names = fsToJs((c.fields || {}).names || { nullValue: null }) || {};
  await sysMsg(token, cid, uid, "left", {});
  await writeMembers(token, cid, members, admins, names);
  if (!members.length) await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { deleted: { booleanValue: true } } }, updateMask: { fieldPaths: ["deleted"] } }]);
  return { left: true };
}
async function opGroupInvite(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  await requireGroupAdmin(token, cid, uid);
  const t = crypto.randomUUID(), exp = new Date(Date.now() + 7 * 86400000).toISOString();
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/ginvites/" + t, fields: { cid: { stringValue: cid }, by: { stringValue: uid }, expiresTs: { timestampValue: exp } } } }]);
  return { token: t, expiresTs: exp };
}
async function opGroupJoin(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = payload && payload.token;
  if (!segOk(String(t || ""))) throw new Error("token required");
  const inv = await fsGet(token, "ginvites/" + t);
  if (!inv) throw new Error("invite not found");
  const exp = inv.fields && inv.fields.expiresTs && inv.fields.expiresTs.timestampValue;
  if (exp && Date.parse(exp) < Date.now()) throw new Error("invite expired");
  const cid = fstr(inv, "cid");
  const c = await chatDoc(token, cid);
  if (!c || fbool(c, "deleted")) throw new Error("group not found");
  const members = fsArr(c, "members");
  if (members.indexOf(uid) >= 0) return { cid, already: true, name: fstr(c, "name") };
  const names = fsToJs((c.fields || {}).names || { nullValue: null }) || {};
  names[uid] = memberIdFields(claims).name.stringValue || null;
  members.push(uid);
  await writeMembers(token, cid, members, fsArr(c, "admins"), names);
  await sysMsg(token, cid, uid, "joined", {});
  return { cid, name: fstr(c, "name") };
}
/* أدوات المجموعة: تصويت · تعديل استطلاع · دفع حصّة · تبرّع (تعهّد) · مهامّ */
async function toolMsg(token, payload, uid, wantType) {
  const { cid, day, id } = payload || {};
  const c = await requireChatMember(token, cid, uid);
  const m = await dayMsg(token, cid, day, id);
  if (m.type !== wantType) throw new Error("wrong message type");
  if (m.del) throw new Error("message deleted");
  return { c, m, cid, day, id };
}
const setPath = (cid, day, fieldPath, value) => ({ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day,
  fields: value === undefined ? {} : nestFields(fieldPath, value) }, updateMask: { fieldPaths: [fieldPath.map(s => "`" + s + "`").join(".")] } });
function nestFields(path, value) {
  let v = toFsValue(value);
  for (let i = path.length - 1; i >= 1; i--) v = { mapValue: { fields: { [path[i]]: v } } };
  return { [path[0]]: v };
}
async function opChatVote(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { m, cid, day, id } = await toolMsg(token, payload, uid, "poll");
  const ex = m.extra || {};
  if (ex.deadline && Date.now() > ex.deadline) throw new Error("poll closed");
  const opt = payload.option == null ? null : Number(payload.option);
  if (opt != null && !(opt >= 0 && opt < (ex.options || []).length)) throw new Error("bad option");
  await fsCommit(token, [setPath(cid, day, ["msgs", id, "votes", uid], opt == null ? undefined : opt)]);
  return { ok: true };
}
async function opChatPollEdit(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { m, cid, day, id } = await toolMsg(token, payload, uid, "poll");
  if (m.by !== uid) throw new Error("only the creator can edit");
  const q = String(payload.question || "").slice(0, 300), opts = (Array.isArray(payload.options) ? payload.options : []).map(x => String(x).slice(0, 120)).filter(Boolean).slice(0, 12);
  if (!q || opts.length < 2) throw new Error("question and two options required");
  const old = (m.extra && m.extra.options) || [], votes = m.votes || {}, keep = {};
  // تبقى أصوات الخيار الذي بقي نصّه كما هو (ولو تغيّر ترتيبه)
  for (const u in votes) { const t = old[votes[u]]; const ni = opts.indexOf(t); if (ni >= 0) keep[u] = ni; }
  const extra = Object.assign({}, m.extra, { question: q, options: opts, editedAt: Date.now() });
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day,
    fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { extra: toFsValue(capVal(extra)), votes: toFsValue(keep) } } } } } } } },
    updateMask: { fieldPaths: [fp("msgs", id, "extra"), fp("msgs", id, "votes")] } }]);
  return { ok: true };
}
async function opChatBillPaid(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { m, cid, day, id } = await toolMsg(token, payload, uid, "bill");
  const who = segOk(String(payload.uid || "")) ? payload.uid : uid;
  if (who !== uid && m.by !== uid) throw new Error("only the creator can mark others");
  if (!((m.extra && m.extra.participants) || []).some(p => p.uid === who)) throw new Error("not a participant");
  await fsCommit(token, [setPath(cid, day, ["msgs", id, "paid", who], payload.paid === false ? undefined : Date.now())]);
  return { ok: true };
}
async function opChatFund(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { m, cid, day, id } = await toolMsg(token, payload, uid, "fund");
  const amount = Math.floor(Number(payload.amount || 0));
  if (!(amount > 0 && amount < 1e9)) throw new Error("bad amount");
  const ex = m.extra || {};
  if (ex.deadline && Date.now() > ex.deadline) throw new Error("fundraiser closed");
  const prev = (m.contrib && m.contrib[uid] && m.contrib[uid].amount) || 0;
  await fsCommit(token, [setPath(cid, day, ["msgs", id, "contrib", uid], { amount: prev + amount, ts: Date.now() })]);
  return { total: prev + amount };
}
async function opChatTask(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { m, cid, day, id } = await toolMsg(token, payload, uid, "tasks");
  const taskId = String(payload.taskId || "");
  if (!((m.extra && m.extra.tasks) || []).some(t => t.id === taskId)) throw new Error("task not found");
  const cur = (m.tstate && m.tstate[taskId]) || {};
  const next = Object.assign({}, cur, { by: uid, ts: Date.now() });
  if (payload.status === "done" || payload.status === "pending") next.status = payload.status;
  if (payload.note != null) next.note = String(payload.note).slice(0, 300);
  await fsCommit(token, [setPath(cid, day, ["msgs", id, "tstate", taskId], next)]);
  return { ok: true };
}

/* ---------- 28) الإشعارات (C5): Firebase Cloud Messaging (HTTP v1) ----------
   accounts/{uid}/devices/{id} = { token, ua, ts } — id = بصمة الرمز. الإرسال «بياناتٌ فقط» فيقرّر عامل الخدمة
   (يُظهر إشعاراً، أو يمرّره للتطبيق المفتوح). المكتومون (chats.mutedBy) لا يصلهم شيء. */
async function tokenId(t) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return "d" + bytesToB64url(h).slice(0, 32).replace(/-/g, "A").replace(/_/g, "B");
}
async function opPushRegister(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = String((payload && payload.token) || "");
  if (t.length < 20 || t.length > 4096) throw new Error("bad token");
  const id = await tokenId(t);
  // رمز الجهاز نفسه قد يكون مسجّلاً لحسابٍ آخر سابقاً (تبديل الحساب): يُنقل لهذا الحساب
  if (payload.prevUid && segOk(String(payload.prevUid)) && payload.prevUid !== uid) {
    await fsCommit(token, [{ delete: DOC_ROOT + "/accounts/" + payload.prevUid + "/devices/" + id }]).catch(() => {});
  }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/accounts/" + uid + "/devices/" + id, fields: {
    token: { stringValue: t }, ua: { stringValue: String(payload.ua || "").slice(0, 160) }, ts: { integerValue: String(Date.now()) } } } }]);
  return { id };
}
async function opPushUnregister(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = String((payload && payload.token) || "");
  if (!t) return { ok: true };
  await fsCommit(token, [{ delete: DOC_ROOT + "/accounts/" + uid + "/devices/" + (await tokenId(t)) }]).catch(() => {});
  return { ok: true };
}
async function fcmSend(token, devToken, data) {
  const res = await fetch("https://fcm.googleapis.com/v1/projects/" + PROJECT_ID + "/messages:send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token: devToken, data: data,
      webpush: { headers: { Urgency: data.t === "call" ? "high" : "normal", TTL: data.t === "call" ? "45" : "86400" } } } }) });
  if (res.ok) return "ok";
  const txt = await res.text();
  return /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT|NOT_FOUND/.test(txt) ? "gone" : "err";
}
// يُرسل لأجهزة مستخدمين (حتّى ١٢ مستخدماً لكلّ حدث — حدّ ٥٠ طلباً فرعيّاً)، ويحذف الرموز الميّتة
async function pushTo(token, uids, data) {
  let sent = 0;
  for (const u of uids.slice(0, 12)) {
    const devs = await fsList(token, "accounts/" + u + "/devices");
    for (const d of devs.slice(0, 3)) {
      const r = await fcmSend(token, fstr(d, "token"), data);
      if (r === "ok") sent++;
      else if (r === "gone") await fsCommit(token, [{ delete: d.name }]).catch(() => {});
    }
  }
  return sent;
}
function strData(o) { const out = {}; for (const k in o) if (o[k] != null) out[k] = String(o[k]).slice(0, 900); return out; }
async function notifyChat(token, c, cid, uid, msg) {
  const members = fsArr(c, "members"), muted = fsArr(c, "mutedBy"), type = fstr(c, "type");
  const names = fsToJs((c.fields || {}).names || { nullValue: null }) || {};
  const senderName = names[uid] || "سوا";
  const mentions = msg.mentions || [];
  // المُشار إليهم أوّلاً (ويصلهم ولو كتموا المجموعة)، ثمّ الباقون غير المكتومين
  const targets = members.filter(u => u !== uid && (mentions.indexOf(u) >= 0 || muted.indexOf(u) < 0))
    .sort((a, b) => (mentions.indexOf(b) >= 0) - (mentions.indexOf(a) >= 0));
  if (!targets.length || type === "saved") return 0;
  const group = type === "group" || type === "family";
  const body = msg.type === "text" || msg.type === "sticker" ? (msg.text || "") : ({ image: "📷 صورة", video: "🎥 فيديو", voice: "🎤 رسالة صوتيّة", file: "📎 ملفّ", poll: "📊 استطلاع", bill: "🧾 فاتورة", fund: "💝 تبرّعات", tasks: "✅ مهامّ", contact: "👤 جهة اتّصال" }[msg.type] || "رسالة");
  const base = { t: "msg", cid, from: uid, mid: msg.id, title: group ? (fstr(c, "name") || "سوا") : senderName, body: group ? senderName + ": " + body : body, ts: msg.ts };
  let sent = 0;
  const ment = targets.filter(u => mentions.indexOf(u) >= 0), rest = targets.filter(u => mentions.indexOf(u) < 0);
  if (ment.length) sent += await pushTo(token, ment, strData(Object.assign({}, base, { mention: "1", title: senderName + " أشار إليك" + (group ? " في " + (fstr(c, "name") || "") : "") })));
  if (rest.length) sent += await pushTo(token, rest.slice(0, 12 - ment.length), strData(base));
  return sent;
}
// الكتم يُنسخ إلى المحادثة نفسها (mutedBy) فلا يقرأ الإرسال إعدادات كلّ عضو
async function syncMutedBy(token, uid, before, after) {
  const b = new Set(before || []), a = new Set(after || []);
  const changes = [];
  a.forEach(cid => { if (!b.has(cid)) changes.push([cid, "appendMissingElements"]); });
  b.forEach(cid => { if (!a.has(cid)) changes.push([cid, "removeAllFromArray"]); });
  for (const [cid, op] of changes.slice(0, 20)) {
    if (!/^(dm_|sv_|fam_|grp_)/.test(cid) || !segOk(cid)) continue;
    await fsCommit(token, [{ transform: { document: DOC_ROOT + "/chats/" + cid, fieldTransforms: [{ fieldPath: "mutedBy", [op]: { values: [{ stringValue: uid }] } }] },
      currentDocument: { exists: true } }]).catch(() => {});
  }
}

/* ---------- 23) schedules.sync — مواعيد المستخدم الشخصيّة بين أجهزته ----------
   accounts/{uid}/schedules/{gid} = { data: JSON { id: item } }. دمجٌ موعداً موعداً: لكلّ موعد _u (وقت تعديله)،
   والأحدث يغلب؛ الحذف علامة { id, _deleted, _u } حتّى لا يعود المحذوف من جهازٍ آخر. */
async function opSchedulesSync(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const groupId = payload && payload.groupId;
  if (!groupId) throw new Error("groupId required");
  const m = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  if (!m) throw new Error("not a member");
  const doc = await fsGet(token, "accounts/" + uid + "/schedules/" + groupId);
  const map = doc ? JSON.parse(fstr(doc, "data") || "{}") : {};
  const changes = Array.isArray(payload.changes) ? payload.changes.slice(0, 500) : [];
  let changed = 0;
  for (const ch of changes) {
    if (!ch || !ch.id) continue;
    const ex = map[ch.id];
    if (!ex || (Number(ch._u) || 0) >= (Number(ex._u) || 0)) { map[ch.id] = ch; changed++; }
  }
  if (changed) {
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/accounts/" + uid + "/schedules/" + groupId,
      fields: { data: { stringValue: JSON.stringify(map) }, updatedTs: { timestampValue: new Date().toISOString() } } } }]);
  }
  return { items: Object.keys(map).map(k => map[k]).filter(x => !x._deleted), changed: changed };
}

/* ---------- المدخل ---------- */
function json(obj, status) {
  obj.ver = VER; // كلّ ردّ يحمل علامة الإصدار الحيّ
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
/* ---------- حدود الطلبات والمعرّفات ---------- */
const RL = new Map(), RL_WINDOW = 5 * 60 * 1000, RL_MAX = 400;   // ٤٠٠ طلب / ٥ دقائق لكلّ مستخدم
function rateOk(uid) {
  const now = Date.now(); let e = RL.get(uid);
  if (!e || now - e.t > RL_WINDOW) { e = { t: now, n: 0 }; RL.set(uid, e); }
  e.n++;
  if (RL.size > 5000) { for (const [k, v] of RL) if (now - v.t > RL_WINDOW) RL.delete(k); }
  return e.n <= RL_MAX;
}
// كلّ معرّفٍ يدخل مسار Firestore: بلا «/» ولا «..» ولا طولٍ مفرط
const ID_KEYS = ["groupId", "personId", "eventId", "relationId", "reviewId", "token", "uid", "from", "to", "cid"];
function badIds(p) {
  if (!p || typeof p !== "object") return null;
  for (const k of ID_KEYS) if (k in p && p[k] != null && !segOk(String(p[k]))) return k;
  if (Array.isArray(p.groupIds) && p.groupIds.some(x => !segOk(String(x)))) return "groupIds";
  return null;
}

export default {
  // Cron (wrangler.toml: [triggers] crons = ["*/15 * * * *"]): حذف الرسائل المؤقّتة المنتهية
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupDisappearing(env).catch(e => console.log("cleanup:", e && e.message)));
  },
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const auth = request.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (!m) return json({ ok: false, error: "no bearer token" }, 401);
      const claims = await verifyIdToken(m[1]);
      const uid = claims.sub;

      // حدٌّ لكلّ مستخدم (تقريبيّ، لكلّ نسخةٍ من الـWorker): يحمي الحصّة المجانيّة من عميلٍ معطوب أو مسيء
      if (!rateOk(uid)) return json({ ok: false, error: "rate_limited" }, 429);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const op = body.op || "whoami";
      const bad = badIds(body.payload);
      if (bad) return json({ ok: false, error: "bad id: " + bad }, 400);

      if (op === "whoami")
        return json({ ok: true, uid, provider: claims.firebase && claims.firebase.sign_in_provider });
      if (op === "group.create") {
        const r = await opGroupCreate(uid, body.payload, env, claims);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "invite.create") {
        const r = await opInviteCreate(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "invite.accept") {
        const r = await opInviteAccept(uid, body.payload, env, claims);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "person.set") {
        const r = await opPersonSet(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "relation.add") {
        const r = await opRelationAdd(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "review.resolve") {
        const r = await opReviewResolve(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "bulk.import") {
        const r = await opBulkImport(uid, body.payload, env, claims);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "person.delete") {
        const r = await opPersonDelete(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "review.list") { const r = await opReviewList(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "photo.set") { const r = await opPhotoSet(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "event.set") { const r = await opEventSet(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "event.delete") { const r = await opEventDelete(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "schedules.sync") { const r = await opSchedulesSync(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.delete") {
        const r = await opGroupDelete(uid, body.payload, env);
        return json({ ok: true, ...r });
      }
      if (op === "group.leave") {
        const r = await opGroupLeave(uid, body.payload, env);
        return json({ ok: true, ...r });
      }
      if (op === "contacts.sync") {
        const r = await opContactsSync(uid, body.payload, env);
        return json({ ok: true, ...r });
      }
      if (op === "my.groups") {
        const r = await opMyGroups(uid, body.payload, env);
        return json({ ok: true, ...r });
      }
      if (op === "account.index") {
        const r = await opAccountIndex(uid, body.payload, env);
        return json({ ok: true, ...r });
      }
      if (op === "account.adopt") {
        const r = await opAccountAdopt(uid, body.payload, env, claims);
        return json({ ok: true, ...r });
      }
      if (op === "relation.update") {
        const r = await opRelationUpdate(uid, body.payload, env);
        return json({ ok: true, ...r });
      }
      if (op === "relation.remove") {
        const r = await opRelationRemove(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "group.new") { const r = await opGroupCreate2(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "group.update") { const r = await opGroupUpdate(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.members") { const r = await opGroupMembers(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.admin") { const r = await opGroupAdmin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.exit") { const r = await opGroupLeave2(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.invite") { const r = await opGroupInvite(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.join") { const r = await opGroupJoin(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "media.viewed") { const r = await opMediaViewed(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.vote") { const r = await opChatVote(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.pollEdit") { const r = await opChatPollEdit(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.billPaid") { const r = await opChatBillPaid(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.fund") { const r = await opChatFund(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.task") { const r = await opChatTask(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.open") { const r = await opChatOpen(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "chat.send") { const r = await opChatSend(uid, body.payload, env, ctx); return json({ ok: true, ...r }); }
      if (op === "push.register") { const r = await opPushRegister(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "push.unregister") { const r = await opPushUnregister(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.edit") { const r = await opChatEdit(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.delete") { const r = await opChatDelete(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.react") { const r = await opChatReact(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.pin") { const r = await opChatPin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.mark") { const r = await opChatMark(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.settings") { const r = await opChatSettings(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.prefs") { const r = await opChatPrefs(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "people.list") { const r = await opPeopleList(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "people.invite") { const r = await opPeopleInvite(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "people.accept") { const r = await opPeopleAccept(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "people.remove") { const r = await opPeopleRemove(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "member.hello") { const r = await opMemberHello(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "member.setRole") { const r = await opMemberSetRole(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "member.remove") { const r = await opMemberRemove(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.settings") { const r = await opGroupSettings(uid, body.payload, env); return json({ ok: true, ...r }); }
      return json({ ok: false, error: "unknown op: " + op }, 400);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 401);
    }
  },
};
