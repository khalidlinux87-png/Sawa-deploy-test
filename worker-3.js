import { connect } from "cloudflare:sockets";   // C178: فحص وسطاء TURN بطلب STUN عبر TCP (مراقبة الخدمات)
/* ============================================================
   worker.js — سوا · applyEdit (v2: التحقّق + الكتابة إلى Firestore)
   ------------------------------------------------------------
   يعمل على Cloudflare Workers (الخطّة المدفوعة منذ C180 — WORKERS_FREE=1 يعيد حدود المجّانيّة).
   v2 يضيف: مفتاح خدمة → رمز وصول Google → الكتابة إلى Firestore.
   أوّل عمليّة: group.create (ينشئ العائلة وعضويّة المالك).

   يتطلّب سرّاً في Cloudflare اسمه SA_JSON = محتوى ملف مفتاح
   الخدمة (Service Account JSON) كاملاً.

   ⚠️ إن أُعيد إنشاء مشروع Firebase بمعرّفٍ جديد، غيّر PROJECT_ID.
   ============================================================ */

const VER = "v92-vup";      // علامة الإصدار — تظهر في كلّ ردّ
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

/* C36: وكيل مصادقة Firebase — يُظهر نطاقنا بدل firebaseapp.com في شاشة Google.
   مسار Worker على www.sawaaap.com/__/* يمرّر /__/auth/* و/__/firebase/* إلى sawa-test-9770f.firebaseapp.com كما هي
   (الطريقة التي توصي بها Firebase: "proxy auth requests to firebaseapp.com"). authDomain في التطبيق = www.sawaaap.com. */
const FB_AUTH_HOST = "sawa-test-9770f.firebaseapp.com";
function isAuthProxyPath(pathname) { return pathname.startsWith("/__/auth/") || pathname.startsWith("/__/firebase/"); }
async function authProxy(request, u) {
  const target = "https://" + FB_AUTH_HOST + u.pathname + u.search;
  const h = new Headers();
  for (const k of ["accept", "accept-language", "content-type", "user-agent", "referer", "origin", "cookie", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]) { const v = request.headers.get(k); if (v) h.set(k, v); }
  const init = { method: request.method, headers: h, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  const r = await fetch(target, init);
  const out = new Headers(r.headers);
  out.delete("content-security-policy"); out.delete("x-frame-options");   // الـiframe يُحمَّل من نطاقنا الآن
  out.set("cache-control", "no-store");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
}
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
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/identitytoolkit",
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
// C187: مسار المستند يجب أن يكون زوجيّ الأجزاء وبلا جزءٍ فارغ (وإلّا يرفضه Firestore بـ«lacks /») — يُرفض قبل الإرسال باسم العملية
function docPathOk(name) {
  if (typeof name !== "string" || !name.startsWith(DOC_ROOT + "/")) return false;
  const seg = name.slice(DOC_ROOT.length + 1).split("/");
  return seg.length % 2 === 0 && seg.every((x) => x.length > 0);
}
function checkWrites(writes) {
  for (const w of writes || []) {
    const n = (w && w.update && w.update.name) || (w && w.delete) || (w && w.transform && w.transform.document);
    if (n !== undefined && !docPathOk(n)) throw new Error("bad doc path: " + String(n).slice(DOC_ROOT.length, DOC_ROOT.length + 160));
  }
}
async function fsCommit(accessToken, writes) {
  checkWrites(writes);
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
/* C37: مواقع الأقارب — {type, lat, lng, radius_meters, address_text} حتى ٣، وإلّا تُسقَط */
function cleanLocations(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const l of v.slice(0, 10)) {
    if (out.length >= 3) break;
    if (!l || typeof l !== "object") continue;
    const lat = Number(l.lat), lng = Number(l.lng);
    if (!(isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || (lat === 0 && lng === 0)) continue;
    let r = Number(l.radius_meters); r = (isFinite(r) && r > 0) ? Math.min(5000, Math.max(100, Math.round(r))) : 0;   // 0 = النطاق العامّ لدى كلّ مستخدم
    out.push({ type: l.type === "work" ? "work" : "home", lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, radius_meters: r, address_text: String(l.address_text || "").slice(0, 120) });
  }
  return out;
}
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
  // C156: دعوةٌ باسم شخصٍ في الشجرة ⇒ يُحفظ معرّفه، فيُربط من يقبلها ويؤكّد «أنا هو» (لا يكفي اختيار اسمٍ بعد الانضمام)
  const ipid = payload && payload.personId != null ? String(payload.personId) : "";
  if (ipid && !segOk(ipid)) throw new Error("bad id");
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/invites/" + inviteToken,
      fields: { groupId: { stringValue: groupId }, createdBy: { stringValue: uid },
                role: { stringValue: grant }, createdTs: { timestampValue: now },
                expiresTs: { timestampValue: expires },
                groupName: { stringValue: fstr(g, "name") || "عائلتي" }, ...(ipid ? { personId: { stringValue: ipid } } : {}) } } },
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
  if (fsArr(g, "banned").indexOf(uid) >= 0) throw new Error("removed from this family");   // v39: من أزاله المالك لا يعود بالرابط
  const gname = fstr(g, "name") || fstr(invite, "groupName") || "عائلتي";
  const now = new Date().toISOString();
  // عضوٌ سلفاً؟ لا نُنزِل دوره — نرفعه فقط إن كانت الدعوة أعلى
  const existing = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const cur = existing ? fstr(existing, "role") : null;
  // C156: «أنا هو» في دعوةٍ باسم شخص ⇒ ربطٌ إن كان الشخص هو نفسه في الدعوة، موجوداً وغير مربوطٍ بغيري، وأنا غير مربوطٍ بآخر
  let claimPid = null;
  const want = payload && payload.claim ? String(payload.claim) : "";
  if (want && want === fstr(invite, "personId") && segOk(want) && !(existing && fstr(existing, "personId"))) {
    const [pd, ms] = await Promise.all([fsGet(token, "groups/" + groupId + "/persons/" + want).catch(() => null), fsList(token, "groups/" + groupId + "/members")]);
    if (pd && !fbool(pd, "deleted") && !ms.some(d => fstr(d, "personId") === want && d.name.split("/").pop() !== uid)) claimPid = want;
  }
  const claimF = claimPid ? { personId: { stringValue: claimPid }, personTs: { integerValue: String(Date.now()) } } : {};
  if (cur && (ROLE_RANK[cur] || 0) >= ROLE_RANK[grant]) {
    await fsCommit(token, [indexWrite(uid, groupId, gname, cur, now)].concat(claimPid ? [{ update: { name: DOC_ROOT + "/groups/" + groupId + "/members/" + uid, fields: claimF }, updateMask: { fieldPaths: ["personId", "personTs"] } }] : []));
    return { groupId: groupId, role: cur, name: gname, already: true, claimed: claimPid };
  }
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/members/" + uid,
      fields: Object.assign({ role: { stringValue: grant }, joinedTs: { timestampValue: now },
                invitedBy: { stringValue: invitedBy } }, memberIdFields(claims), claimF) } },
    indexWrite(uid, groupId, gname, grant, now),
  ]);
  try { await famChatSync(token, groupId); } catch (e) {}
  return { groupId: groupId, role: grant, name: gname, claimed: claimPid };
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
  // اسم «سوا» الذي اختاره المستخدم يسبق اسم Google (ويصلح للضيف أيضاً)
  const nm = claims && typeof claims.sawaName === "string" && claims.sawaName ? claims.sawaName.slice(0, 60)
    : !anon && claims && typeof claims.name === "string" ? claims.name.trim().slice(0, 60) : "";
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
                   "status_detail", "noChildren", "locations"];

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

  // v39: «الأحدث يفوز» لكلّ حقل — العميل يرسل وقت تعديله (ts)؛ حقلٌ كُتب في الخادم بعده يُترك كما هو (كان المتأخّر وصولاً يمسح الأحدث)
  const editTs = Number(payload && payload.ts) || 0, exFts = (!creating && (await fsGet(token, "groups/" + groupId + "/persons/" + pid).catch(() => null)) || null);
  const srvTs = (k) => { try { const v = exFts.fields.fts.mapValue.fields[k].timestampValue; return Date.parse(v) || 0; } catch (e) { return 0; } };
  const changed = [], skipped = [], updFields = {}, ftsSub = {};
  for (const k of ALLOWED) if (k in fields) {
    if (editTs && exFts && srvTs(k) > editTs + 2000) { skipped.push(k); continue; }
    if (k === "locations") fields[k] = cleanLocations(fields[k]);   // C37
    updFields[k] = toFsValue(capVal(fields[k])); ftsSub[k] = { timestampValue: editTs ? new Date(Math.min(editTs, Date.now())).toISOString() : now }; changed.push(k);
  }
  if (changed.length === 0 && !creating) return { personId: pid, created: false, changed: [], skipped };
  if (creating) {   // v39: سقف الأشخاص في العائلة
    try { const n = await fsCount(token, "groups/" + groupId, "persons"); if (n >= 5000) throw new Error("family is full (5000)"); } catch (e) { if (/full/.test(String(e && e.message))) throw e; }
  }

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
  return { personId: pid, created: creating, changed: changed, skipped };
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
  if (!segOk(String(from)) || !segOk(String(to))) throw new Error("bad id");
  // v39: الطرفان من هذه العائلة وغير محذوفَين (كانت تُقبل معرّفاتٌ من عائلةٍ أخرى أو وهميّة)
  const [pf, pt] = await Promise.all([fsGet(token, "groups/" + groupId + "/persons/" + from), fsGet(token, "groups/" + groupId + "/persons/" + to)]);
  if (!pf || fbool(pf, "deleted") || !pt || fbool(pt, "deleted")) throw new Error("person not found");

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
                                      relationId: payload.relationId ? String(payload.relationId) : null,
                                      half: (type === "sibling" && (payload.half === "father" || payload.half === "mother")) ? payload.half : null }) } } },
    ]);
    return { applied: false, queued: true, reviewId: rid, reason: conflict };
  }

  // المعرّف المحلّيّ = معرّف الخادم (قرار §٨-١): استعمل relationId من العميل إن وُجد
  const relId = (payload.relationId && String(payload.relationId)) || crypto.randomUUID();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/relations/" + relId,
      fields: Object.assign({ type: { stringValue: type }, from: { stringValue: from }, to: { stringValue: to },
                createdTs: { timestampValue: now }, deleted: { booleanValue: false } },
                payload.inferred ? { inferred: { stringValue: String(payload.inferred).slice(0, 60) } } : {},
                // v53: الأخوّة غير الشقيقة — «من الأب» أو «من الأم» (C75)
                (type === "sibling" && (payload.half === "father" || payload.half === "mother")) ? { half: { stringValue: payload.half } } : {}) } },
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
                    fromReview: { stringValue: reviewId },
                    ...((d.half && d.half.stringValue && type === "sibling") ? { half: { stringValue: d.half.stringValue } } : {}) } } },
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
                       "death_date", "deathYear", "contacts", "phones", "notes", "motherId", "status_detail", "noChildren", "locations"];
      const f = { deleted: { booleanValue: false }, updatedTs: { timestampValue: now } }, mask = ["deleted", "updatedTs"];
      for (const k of ALLOWED) if (k in vals) { f[k] = toFsValue(capVal(k === "locations" ? cleanLocations(vals[k]) : vals[k])); mask.push(k); }
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
                   "status_detail", "noChildren", "locations"];

  // خريطة المعرّفات المحلّية → الخادم. مع حفظ المعرّفات: fid = lid (لا تبديل).
  const map = {}; let selfCount = 0; const personWrites = [];
  for (const p of persons) {
    const lid = (p.localId && segOk(String(p.localId))) ? String(p.localId) : crypto.randomUUID();
    const fid = lid; map[p.localId || lid] = fid;
    if (p.kinship === "نفسي") selfCount++;
    const f = { deleted: { booleanValue: false }, createdTs: { timestampValue: now }, updatedTs: { timestampValue: now } };
    const ftsSub = {};
    for (const k of ALLOWED) if (k in p) { f[k] = toFsValue(capVal(k === "locations" ? cleanLocations(p[k]) : p[k])); ftsSub[k] = { timestampValue: now }; }
    // ⛔ healthStatus لا يُنسَخ (خارج ALLOWED) — لا يعبر القاعدة
    f.fts = { mapValue: { fields: ftsSub } };
    personWrites.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/persons/" + fid, fields: f } });
  }

  // إعادة تأصيل الصلات؛ ما سقط طرفه يُتخطّى
  let orphans = 0; const relWrites = [];
  for (const r of relations) {
    const from = map[r.fromLocalId], to = map[r.toLocalId];
    if (!from || !to) { orphans++; continue; }
    if (["parent", "spouse", "ex_spouse", "sibling"].indexOf(r.type) < 0 || from === to) { orphans++; continue; }   // v39
    const rid = (r.localId && segOk(String(r.localId))) ? String(r.localId) : crypto.randomUUID();
    relWrites.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/relations/" + rid,
      fields: Object.assign({ type: { stringValue: r.type }, from: { stringValue: from }, to: { stringValue: to },
                createdTs: { timestampValue: now }, deleted: { booleanValue: false } },
                r.inferred ? { inferred: { stringValue: String(r.inferred).slice(0, 60) } } : {},
                (r.type === "sibling" && (r.half === "father" || r.half === "mother")) ? { half: { stringValue: r.half } } : {}) } });
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
  // v39: صلاته تُشطب معه (كانت تبقى معلّقةً بشخصٍ محذوف)
  const relW = [];
  try {
    const rs = [].concat(await fsQuerySub(token, "groups/" + groupId, "relations", [["from", "EQUAL", pid]], 200), await fsQuerySub(token, "groups/" + groupId, "relations", [["to", "EQUAL", pid]], 200));
    for (const r of rs) if (!fbool(r, "deleted")) relW.push({ update: { name: r.name, fields: { deleted: { booleanValue: true }, deletedTs: { timestampValue: now } } }, updateMask: { fieldPaths: ["deleted", "deletedTs"] } });
  } catch (e) { console.log("person.delete rels:", e && e.message); }
  if (relW.length) await commitChunks(token, relW.slice(0, 400));
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
  for (const gid of adopted.slice(0, 8)) { try { await famChatSync(token, gid); } catch (e) {} }   // v39: محادثة العائلة تعرف هويّتي الجديدة فوراً
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
  // v39: المجموعات الفرعيّة (الأشخاص، الصلات، الصور…) كانت تبقى إلى الأبد — تُحذف بالـCron
  const pj = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  writes.push({ update: { name: DOC_ROOT + "/purge/" + pj, fields: { kind: { stringValue: "family" }, uid: { stringValue: "__deleted__" }, gid: { stringValue: gid }, cid: { nullValue: null }, ts: { integerValue: String(Date.now()) } } } });
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
  for (const gid of updated.slice(0, 6)) { try { await famChatSync(token, gid); } catch (e) {} }   // v39: اسمي في محادثة العائلة
  return { updated };
}
// v39: المالك يرفع المنع عن عضوٍ أزاله (ليعود بالرابط)
async function opMemberUnban(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = payload && payload.groupId, target = payload && payload.uid;
  if (!segOk(gid) || !segOk(target)) throw new Error("groupId/uid required");
  await requireOwner(token, gid, uid);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/groups/" + gid }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: "banned", removeAllFromArray: { values: [{ stringValue: target }] } }] }]);
  return { groupId: gid, uid: target, unbanned: true };
}
// v66 (C114): قائمة المُزالين للمالك — كان من أُزيل مرّةً لا يعود بأيّ رابطٍ جديد («تعذّر الانضمام») ولا زرّ لرفع المنع
async function opMemberBanned(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = payload && payload.groupId;
  if (!segOk(gid)) throw new Error("groupId required");
  await requireOwner(token, gid, uid);
  const g = await fsGet(token, "groups/" + gid);
  const ids = fsArr(g, "banned").slice(-50);
  const nm = (((g && g.fields && g.fields.bannedNames && g.fields.bannedNames.mapValue) || {}).fields) || {};
  const out = await Promise.all(ids.map(async (u) => {
    let name = nm[u] && nm[u].stringValue || null;
    if (!name) { const a = await fsGet(token, "accounts/" + u).catch(() => null); name = fstr(a, "displayName") || fstr(a, "gname") || null; }
    return { uid: u, name };
  }));
  return { banned: out };
}
// v62 (C106): ربط شخصٍ في الشجرة بحساب سوا — المرحلة ١: «هذا أنا» على الخادم (groups/{g}/members/{uid}.personId)
//   العضو يربط نفسه بشخص (أو يفكّ الربط بـ personId:null) · المالك يفكّ ربط غيره إن كان خطأً (target).
//   شخصٌ واحد لكلّ حساب، وحسابٌ واحد لكلّ شخص في الشجرة نفسها.
async function opFamClaim(uid, payload, env) {
  if (!codeRate(uid, "famclaim", 30)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = String((payload && payload.groupId) || ""), pid = payload && payload.personId != null ? String(payload.personId) : null;
  const target = payload && payload.target ? String(payload.target) : uid;
  if (!segOk(gid) || (pid !== null && !segOk(pid)) || !segOk(target)) throw new Error("bad id");
  const me = await fsGet(token, "groups/" + gid + "/members/" + uid);
  if (!me) throw new Error("not a member");
  const myRole = fstr(me, "role");
  // C156: التعريف من داخل العائلة — المشاهد لا يربط نفسه بشخصٍ في الشجرة (كان يكفي اختيار اسمٍ أو تشابهه)؛
  //       يربطه محرّرٌ بطلب «هل هذا أنت؟» أو بدعوةٍ باسمه. فكّ ربط نفسه متاحٌ للجميع.
  if (target === uid && pid !== null && myRole !== "owner" && myRole !== "editor") throw new Error("ask_family");
  if (target !== uid) {   // فكّ ربط غيري: للمالك والمحرّر، وإلى لا شيء فقط (C156: كان للمالك وحده)
    if ((myRole !== "owner" && myRole !== "editor") || pid !== null) throw new Error("only the owner can unlink others");
    const t0 = await fsGet(token, "groups/" + gid + "/members/" + target);
    if (!t0) throw new Error("not a member");
  }
  if (pid !== null) {
    const pd = await fsGet(token, "groups/" + gid + "/persons/" + pid);
    if (!pd || fbool(pd, "deleted")) throw new Error("person not found");
    const taken = (await fsList(token, "groups/" + gid + "/members")).find(d => fstr(d, "personId") === pid && d.name.split("/").pop() !== target);
    if (taken) throw new Error("person taken");
  }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + target,
    fields: pid !== null ? { personId: { stringValue: pid }, personTs: { integerValue: String(Date.now()) } } : {} },
    updateMask: { fieldPaths: ["personId", "personTs"] }, currentDocument: { exists: true } }]);
  stat("fam:claim");
  return { personId: pid };
}
// v63 (C107): المرحلة ٢ — المحرّر يربط قريباً بحسابه (برمز سوا أو من جهات اتّصاله) ⇒ طلب موافقة يصل صاحبَ الحساب إشعاراً
//   famreq/{gid~pid~uid} · القبول يضمّه عضواً «مشاهداً» (إن لم يكن) ويربطه بالشخص · الرفض يحذف الطلب. لا ربط بلا موافقة.
const FAMREQ_TTL = 14 * 86400000;
function famReqId(gid, pid, u) { return gid + "~" + pid + "~" + u; }
async function opFamLinkReq(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "famreq", 20)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = payload || {}, gid = String(p.groupId || ""), pid = String(p.personId || "");
  if (!segOk(gid) || !segOk(pid)) throw new Error("bad id");
  await requireEditor(token, gid, uid);
  const [g, pd] = await Promise.all([fsGet(token, "groups/" + gid), fsGet(token, "groups/" + gid + "/persons/" + pid)]);
  if (!g || fbool(g, "deleted")) throw new Error("family not found");
  if (!pd || fbool(pd, "deleted")) throw new Error("person not found");
  let t = null;
  if (p.code) t = await codeTarget(token, p.code);   // يحترم «إخفاء رمزي»
  else if (p.byPhone) {   // v64 (C109): الرقم المحفوظ للشخص في الشجرة نفسها — لا رقمٌ يرسله العميل
    t = await phoneOwner(token, personPhone(pd));
    if (!t) return { found: false };
  }
  else if (p.uid && segOk(String(p.uid))) {
    // جهة اتّصال، أو عضوٌ في العائلة نفسها (من شاشة الأعضاء)
    const okRel = (await sharesContact(token, uid, String(p.uid))) || !!(await fsGet(token, "groups/" + gid + "/members/" + String(p.uid)).catch(() => null));
    if (!okRel) throw new Error("not a contact");
    const acc = await fsGet(token, "accounts/" + p.uid).catch(() => null);
    t = { uid: String(p.uid), name: fstr(acc, "displayName") || fstr(acc, "gname") || null };
  }
  if (!t) return { found: false };
  if (t.uid === uid) throw new Error("use this is me");
  const ms = await fsList(token, "groups/" + gid + "/members");
  // C156: «تغيير الحساب المربوط» (غيّر قريبك حسابه أو رقمه) — الربط القديم يبقى حتّى يوافق صاحب الحساب الجديد
  const holder = ms.find(d => fstr(d, "personId") === pid);
  if (holder && holder.name.split("/").pop() === t.uid) throw new Error("already this account");
  if (holder && !p.replace) throw new Error("person taken");
  const tm = ms.find(d => d.name.split("/").pop() === t.uid);
  if (tm && fstr(tm, "personId")) throw new Error("already linked");
  if (fsArr(g, "banned").indexOf(t.uid) >= 0) throw new Error("removed from this family");
  // من حظرني: لا يصله شيء ولا أخبر المرسل
  if (await blockedBy(token, t.uid, uid).catch(() => false)) return { sent: true, name: t.name || null };
  const me = await myName(token, uid, claims), now = Date.now();
  const pname = fstr(pd, "local_name") || "", gname = fstr(g, "name") || "عائلتي";
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/famreq/" + famReqId(gid, pid, t.uid), fields: {
    gid: { stringValue: gid }, pid: { stringValue: pid }, uid: { stringValue: t.uid }, by: { stringValue: uid },
    byName: { stringValue: String(me || "").slice(0, 80) }, gname: { stringValue: gname.slice(0, 80) }, pname: { stringValue: pname.slice(0, 80) },
    replace: { booleanValue: !!holder }, ts: { integerValue: String(now) } } } }]);
  const job = pushTo(token, [t.uid], strData({ t: "famreq", title: "طلب ربط في شجرة العائلة",
    body: (me || "قريبك") + " يقول إنك «" + pname + "» في شجرة «" + gname + "» — هل هذا أنت؟", ts: now })).catch(e => console.log("push:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  await sigTo(token, [t.uid], "famreq");
  stat("fam:linkreq");
  return { sent: true, name: t.name || null };
}
// v64 (C109): المرحلة ٤ — اقتراح الربط بالأرقام الموثَّقة. يُطابَق رقم الشخص المحفوظ في الشجرة (contacts.phone)
//   مع phones/{رقم} لحسابٍ موثَّق الرقم ويقبل الإيجاد (findable) — بالقواعد نفسها لـ find.phone. للمحرّرين فقط.
function personPhone(pd) {
  try { const c = pd && pd.fields && pd.fields.contacts && pd.fields.contacts.mapValue && pd.fields.contacts.mapValue.fields; const v = c && c.phone; return cleanPhone(v && (v.stringValue || v.integerValue)); } catch (e) { return null; }
}
async function phoneOwner(token, ph) {
  if (!ph) return null;
  const d = await fsGet(token, "phones/" + ph).catch(() => null);
  const u = fstr(d, "uid"); if (!u) return null;
  const acc = await fsGet(token, "accounts/" + u).catch(() => null);
  if (!acc || !accFindable(acc) || fbool(acc, "phoneVerified") !== true || fstr(acc, "phone") !== ph) return null;
  return { uid: u, name: fstr(acc, "displayName") || fstr(acc, "gname") || null };
}
async function opFamSuggest(uid, payload, env) {
  if (!codeRate(uid, "famsug", 12)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = payload || {}, gid = String(p.groupId || ""), only = p.personId ? String(p.personId) : null;
  if (!segOk(gid) || (only && !segOk(only))) throw new Error("bad id");
  await requireEditor(token, gid, uid);
  const [g, ms, ps] = await Promise.all([fsGet(token, "groups/" + gid), fsList(token, "groups/" + gid + "/members"),
    only ? fsGet(token, "groups/" + gid + "/persons/" + only).then(d => d ? [d] : []) : fsList(token, "groups/" + gid + "/persons")]);
  if (!g || fbool(g, "deleted")) throw new Error("family not found");
  const banned = new Set(fsArr(g, "banned")), linkedP = new Set(), linkedU = new Set();
  for (const m of ms) { const pid = fstr(m, "personId"); if (pid) { linkedP.add(pid); linkedU.add(m.name.split("/").pop()); } }
  const cand = [];
  for (const d of ps) {
    if (fbool(d, "deleted") || (d.fields && d.fields.alive && d.fields.alive.booleanValue === false)) continue;
    const pid = d.name.split("/").pop(); if (linkedP.has(pid)) continue;
    const ph = personPhone(d); if (ph) cand.push({ pid, ph, pname: fstr(d, "local_name") || "" });
    if (cand.length >= 120) break;
  }
  const seen = new Set(), out = [];
  const hits = await Promise.all(cand.map(c => phoneOwner(token, c.ph).catch(() => null)));
  for (let i = 0; i < cand.length; i++) {
    const t = hits[i]; if (!t || t.uid === uid || linkedU.has(t.uid) || banned.has(t.uid) || seen.has(t.uid)) continue;
    if (await blockedBy(token, t.uid, uid).catch(() => false)) continue;
    seen.add(t.uid);
    const rq = await fsGet(token, "famreq/" + famReqId(gid, cand[i].pid, t.uid)).catch(() => null);
    out.push({ personId: cand[i].pid, personName: cand[i].pname, uid: t.uid, name: t.name, pending: !!(rq && Date.now() - fsInt(rq, "ts") < FAMREQ_TTL) });
  }
  stat("fam:suggest");
  return { sugg: out };
}
async function opFamReqs(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const rows = await fsQueryEq(token, "famreq", { uid: uid }, 30);
  const now = Date.now();
  return { reqs: rows.filter(d => now - fsInt(d, "ts") < FAMREQ_TTL).map(d => ({ groupId: fstr(d, "gid"), personId: fstr(d, "pid"), by: fstr(d, "by"),
    byName: fstr(d, "byName") || null, groupName: fstr(d, "gname"), personName: fstr(d, "pname"), ts: fsInt(d, "ts") })) };
}
async function opFamLinkRespond(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = payload || {}, gid = String(p.groupId || ""), pid = String(p.personId || "");
  if (!segOk(gid) || !segOk(pid)) throw new Error("bad id");
  const rq = await fsGet(token, "famreq/" + famReqId(gid, pid, uid));
  if (!rq) throw new Error("request not found");
  await fsCommit(token, [{ delete: rq.name }]);
  if (!p.accept) return { ok: true, declined: true };
  if (Date.now() - fsInt(rq, "ts") > FAMREQ_TTL) throw new Error("request expired");
  const g = await fsGet(token, "groups/" + gid);
  if (!g || fbool(g, "deleted")) throw new Error("family not found");
  if (fsArr(g, "banned").indexOf(uid) >= 0) throw new Error("removed from this family");
  const pd = await fsGet(token, "groups/" + gid + "/persons/" + pid);
  if (!pd || fbool(pd, "deleted")) throw new Error("person not found");
  const ms = await fsList(token, "groups/" + gid + "/members");
  const old = ms.filter(d => fstr(d, "personId") === pid && d.name.split("/").pop() !== uid);
  if (old.length && !fbool(rq, "replace")) throw new Error("person taken");
  const gname = fstr(g, "name") || "عائلتي", nowIso = new Date().toISOString();
  const mine = ms.find(d => d.name.split("/").pop() === uid);
  const role = mine ? fstr(mine, "role") : "viewer";
  const w = old.map(d => ({ update: { name: d.name, fields: {} }, updateMask: { fieldPaths: ["personId", "personTs"] } }));   // C156: يُفكّ الحساب القديم
  if (!mine) {
    w.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid,
      fields: Object.assign({ role: { stringValue: "viewer" }, joinedTs: { timestampValue: nowIso }, invitedBy: { stringValue: fstr(rq, "by") },
        personId: { stringValue: pid }, personTs: { integerValue: String(Date.now()) } }, memberIdFields(claims)) } });
    w.push(indexWrite(uid, gid, gname, "viewer", nowIso));
  } else {
    w.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid, fields: { personId: { stringValue: pid }, personTs: { integerValue: String(Date.now()) } } },
      updateMask: { fieldPaths: ["personId", "personTs"] } });
  }
  await fsCommit(token, w);
  if (!mine) { try { await famChatSync(token, gid); } catch (e) {} }
  const by = fstr(rq, "by");
  if (by) {
    await pushTo(token, [by], strData({ t: "famok", title: "تمّ الربط ✓", body: (await myName(token, uid, claims) || "قريبك") + " أكّد أنّه «" + (fstr(pd, "local_name") || "") + "» في «" + gname + "»", ts: Date.now() })).catch(() => {});
  }
  stat("fam:linkok");
  return { ok: true, groupId: gid, name: gname, role: role, personId: pid, joined: !mine };
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
    // v39: يُمنع من العودة برابط دعوةٍ ما زال صالحاً (يزول المنع بدعوةٍ من المالك عبر member.unban أو بحذف الدعوات)
    { update: { name: DOC_ROOT + "/groups/" + gid, fields: { bannedNames: { mapValue: { fields: { [target]: { stringValue: String(fstr(m, "name") || "").slice(0, 60) } } } } } },
      updateMask: { fieldPaths: [fp("bannedNames", target)] },   // v66: اسمه في قائمة «المُزالون» عند المالك
      updateTransforms: [{ fieldPath: "banned", appendMissingElements: { values: [{ stringValue: target }] } }] },
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
  const add = (u, name, anon, via, fam, phone) => {
    if (!u || u === uid) return;
    const p = people[u] || (people[u] = { uid: u, name: null, anon: false, families: [], via: {}, phone: null });
    if (name && !p.name) p.name = name;
    if (phone && !p.phone) p.phone = phone;
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
    for (const m of ms) { const u = m.name.split("/").pop(); if (!hidden.has(u)) add(u, fstr(m, "name"), fbool(m, "anon"), "family", fam, fstr(m, "phone")); }
  }
  for (const d of await fsList(token, "accounts/" + uid + "/people")) add(d.name.split("/").pop(), fstr(d, "name"), fbool(d, "anon"), "link", null, fstr(d, "phone"));
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
  let cd = { code: null, findable: true }, pv = false;
  try { const pr = await profileOf(token, uid); pv = !!pr.phoneVerified; cd = pr.code ? { code: pr.code, findable: pr.findable } : await ensureCode(token, uid, claims, false); } catch (e) {}
  return { me: { uid, name: me.name.stringValue || null, anon: me.anon.booleanValue, phone: claims.sawaPhone || null, phoneVerified: pv, verifiedBy: pv ? (((PROFILE_CACHE.get(uid) || {}).verifiedBy) || "whatsapp") : null, emailVerified: !!(claims.email && claims.email_verified), googleName: claims.name || null, code: cd.code, findable: cd.findable },
           people: list.map(p => ({ uid: p.uid, name: p.name, anon: p.anon, families: p.families, via: Object.keys(p.via), phone: p.phone || null })), acl: aclOk };
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
  await sigTo(token, [other], "reqok");
  return { uid: other, name: fstr(inv, "name") || null };
}
// v34: معاينة الرابط قبل القبول — التطبيق يسأل «أضِفه؟ / انضمّ؟» ولا يُنفَّذ الرابط وحده
async function opPeoplePeek(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = payload && payload.token;
  if (!segOk(String(t || ""))) throw new Error("token required");
  const inv = await fsGet(token, "pinvites/" + t);
  if (!inv || !fstr(inv, "uid")) throw new Error("invite not found");
  const exp = inv.fields && inv.fields.expiresTs && inv.fields.expiresTs.timestampValue;
  if (exp && Date.parse(exp) < Date.now()) throw new Error("invite expired");
  const other = fstr(inv, "uid");
  if (other === uid) return { self: true };
  const mine = await fsGet(token, "accounts/" + uid + "/people/" + other).catch(() => null);
  return { name: fstr(inv, "name") || null, anon: fbool(inv, "anon"), already: !!mine };
}
async function opGroupPeek(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = payload && payload.token;
  if (!segOk(String(t || ""))) throw new Error("token required");
  const inv = await fsGet(token, "ginvites/" + t);
  if (!inv) throw new Error("invite not found");
  const exp = inv.fields && inv.fields.expiresTs && inv.fields.expiresTs.timestampValue;
  if (exp && Date.parse(exp) < Date.now()) throw new Error("invite expired");
  const c = await chatDoc(token, fstr(inv, "cid"));
  if (!c || fbool(c, "deleted")) throw new Error("group not found");
  const members = fsArr(c, "members");
  if (fsArr(c, "banned").indexOf(uid) >= 0) throw new Error("removed from this group");
  return { name: fstr(c, "name") || null, count: members.length, already: members.indexOf(uid) >= 0, cid: members.indexOf(uid) >= 0 ? fstr(inv, "cid") : null };
}
async function opPeopleRemove(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const other = payload && payload.uid;
  if (!segOk(other)) throw new Error("uid required");
  await fsCommit(token, [
    { delete: DOC_ROOT + "/accounts/" + uid + "/people/" + other },
    { delete: DOC_ROOT + "/accounts/" + other + "/people/" + uid },
  ]);
  // v33: يتوقّف فوراً عن رؤية حضوري والاتّصال بي (كان ينتظر people.list التالي). إن جمعتنا عائلة يعيدها people.list
  try { await rtdbPatch(token, { ["acl/" + uid + "/" + other]: null, ["acl/" + other + "/" + uid]: null }); } catch (e) {}
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
const MSG_TYPES = ["text", "sticker", "contact", "voice", "image", "video", "file", "poll", "bill", "fund", "tasks", "system", "location"];   // v38: موقع
// v35: وثيقة اليوم حدّها ١ ميغابايت — المحادثة المزدحمة تكتب بعد ٨٥٠ ألف حرف في جزءٍ تالٍ «YYYYMMDD-2» (العميل يقرأ الأجزاء كأيّام)
const DAY_REF = /^\d{8}(-\d{1,3})?$/, SHARD_MAX = 850000;
const tooBig = (e) => /maximum allowed size|exceeds the maximum|too large|INVALID_ARGUMENT.*size/i.test(String((e && e.message) || e));
function shardOf(c, ts, len, bump) {
  const day = dayKey(ts), s = (c && c.fields && c.fields.shard && fsToJs(c.fields.shard)) || null;
  let n = s && s.day === day ? (Number(s.n) || 1) : 1, sz = s && s.day === day ? (Number(s.sz) || 0) : 0;
  if (bump || sz + len > SHARD_MAX) { n = bump ? Math.max(n, bump) + 1 : n + 1; sz = 0; }
  return { day, n, sz: sz + len, key: n > 1 ? day + "-" + n : day };
}
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
/* ---------- v36: المحادثات السرّيّة (تشفيرٌ بين الطرفين) ----------
   الخادم لا يرى المحتوى: يحفظ المفاتيح العامّة لأجهزة الأعضاء ويمرّر النصّ المشفّر كما وصل.
   chats/{cid}.e2e = { on: true, devs: { uid: devId }, keys: { devId: { u: uid, k: مفتاح P-256 العامّ (٦٥ بايت base64), ts } } }
   - كلّ عضوٍ يربط جهازاً واحداً (devs). مفتاح الجهاز لا يتغيّر بعد تسجيله (keys إلحاقٌ فقط) ⇒ الرسائل القديمة تبقى قابلةً للفكّ.
   - الرسالة: { id, type, enc: { v, d: جهاز المرسل, iv, ct, k: { devId: مفتاح الرسالة مغلّفاً لذلك الجهاز } }, reply: { id, day }, extra: { mid, viewOnce } } */
const E2E_DEV = /^[A-Za-z0-9]{16,24}$/, E2E_B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const E2E_TYPES = ["text", "sticker", "contact", "voice", "image", "video", "file", "location", "tasks"];   // C164: قائمة المهامّ في السرّيّة (العنوان والمهامّ داخل enc)
function e2eOf(c) { const v = c && c.fields && c.fields.e2e; const e = v ? fsToJs(v) : null; return e && e.on ? e : null; }
function e2ePubOk(k) {
  k = String(k || ""); if (k.length !== 88 || !E2E_B64.test(k)) return false;
  try { const b = atob(k); return b.length === 65 && b.charCodeAt(0) === 4; } catch (e) { return false; }
}
// معرّف الجهاز مشتقٌّ من مفتاحه (أوّل ١٢ بايت من SHA-256 بالست عشريّ): لا ينتحل أحدٌ معرّف جهاز غيره بمفتاحٍ آخر
async function e2eDevOf(k) {
  const raw = Uint8Array.from(atob(k), ch => ch.charCodeAt(0));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return Array.from(h.slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
}
async function e2eDevKey(p) {
  const d = String((p && p.d) || ""), k = String((p && p.k) || "");
  if (!E2E_DEV.test(d) || !e2ePubOk(k)) throw new Error("bad e2e key");
  if (await e2eDevOf(k) !== d) throw new Error("bad e2e key");
  return { d, k };
}
function cleanEnc(en, uid, e) {
  if (!en || typeof en !== "object") throw new Error("encrypted payload required");
  const myDev = e && e.devs && e.devs[uid];
  if (!myDev || en.d !== myDev) throw new Error("e2e device not bound");
  const iv = String(en.iv || ""), ct = String(en.ct || "");
  if (iv.length !== 16 || !E2E_B64.test(iv)) throw new Error("bad e2e payload");
  if (ct.length < 24 || ct.length > 40000 || !E2E_B64.test(ct)) throw new Error("bad e2e payload");
  const k = {}; let n = 0;
  for (const d of Object.keys(en.k || {})) {
    const w = String(en.k[d] || "");
    if (!E2E_DEV.test(d) || w.length < 40 || w.length > 120 || !E2E_B64.test(w)) throw new Error("bad e2e payload");
    k[d] = w; if (++n > 300) throw new Error("bad e2e payload");
  }
  if (!n) throw new Error("bad e2e payload");
  return { v: 1, d: en.d, iv, ct, k };
}
function cleanEncMsg(m, uid, ts, e) {
  if (!m || !MSG_ID.test(String(m.id || ""))) throw new Error("bad message id");
  const type = m.type || "text";
  if (E2E_TYPES.indexOf(type) < 0) throw new Error("bad type for a secret chat");
  const out = { id: m.id, by: uid, ts: ts, type: type, enc: cleanEnc(m.enc, uid, e) };   // لا نصّ ظاهر: ما ليس داخل enc يُهمَل
  if (m.reply && MSG_ID.test(String(m.reply.id || ""))) out.reply = { id: m.reply.id, day: DAY_REF.test(String(m.reply.day || "")) ? String(m.reply.day) : null, e2e: true };
  if (m.fwd) out.fwd = true;
  if (Array.isArray(m.mentions)) out.mentions = m.mentions.filter(x => segOk(String(x))).slice(0, 50);
  if (MEDIA_TYPES.indexOf(type) >= 0) {
    const mid = m.extra && m.extra.mid;
    if (!MEDIA_ID.test(String(mid || ""))) throw new Error("media id required");
    out.extra = { mid: mid };
    if (m.extra.viewOnce) out.extra.viewOnce = true;
  }
  if (JSON.stringify(out).length > 48000) throw new Error("message too large");
  return out;
}
async function e2eNames(token, uid, to, me) {
  const other = await fsGet(token, "accounts/" + uid + "/people/" + to);
  let otherName = other ? fstr(other, "name") : null;
  if (!otherName) {
    for (const d of (await fsList(token, "accounts/" + uid + "/groups")).slice(0, 20)) {
      const m = await fsGet(token, "groups/" + d.name.split("/").pop() + "/members/" + to); if (m && fstr(m, "name")) { otherName = fstr(m, "name"); break; }
    }
  }
  return { [uid]: me.name.stringValue || null, [to]: otherName || null };
}
// محادثةٌ سرّيّة مع شخص: معرّفٌ جديد كلّ مرّة (sdm_…)، مرتبطةٌ بهذا الجهاز. الطرف الآخر يفعّلها على جهازه (e2e.join).
async function opE2eDm(uid, payload, env, claims) {
  if (!codeRate(uid, "e2e", 20)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const to = payload && payload.to;
  if (!segOk(to) || to === uid) throw new Error("to required");
  const dk = await e2eDevKey(payload);
  if (!(await sharesContact(token, uid, to))) throw new Error("not a contact");
  if (await blockedBy(token, to, uid)) throw new Error("not a contact");   // لا نخبره أنّه محظور
  const now = Date.now(), cid = "sdm_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const names = await e2eNames(token, uid, to, memberIdFields(claims));
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { type: { stringValue: "dm" }, members: toFsValue([uid, to].sort()),
    names: toFsValue(names), createdTs: { integerValue: String(now) }, createdBy: { stringValue: uid }, updatedTs: { integerValue: String(now) }, cnt: { integerValue: "0" },
    e2e: toFsValue({ on: true, devs: { [uid]: dk.d }, keys: { [dk.d]: { u: uid, k: dk.k, ts: now } } }) } }, currentDocument: { exists: false } }]);
  await rtdbSetChatMembers(token, cid, [uid, to]);
  await sysMsg(token, cid, uid, "e2e_on", {});
  try {   // إشعارٌ بالدعوة (بلا محتوى)
    const c = await chatDoc(token, cid);
    if (c) await notifyChat(token, c, cid, uid, { id: "e2einv", type: "text", text: "🔒 دعاك إلى محادثة سرّيّة", ts: now });
  } catch (e) { console.log("e2e invite push:", e && e.message); }
  return { cid };
}
// تفعيل المحادثة السرّيّة على هذا الجهاز (أوّل مرّة، أو نقلها من جهازٍ آخر ⇒ «تغيّر رمز الأمان» يظهر للجميع)
async function opE2eJoin(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  const e = e2eOf(c); if (!e) throw new Error("not a secret chat");
  const dk = await e2eDevKey(payload), keys = e.keys || {}, devs = e.devs || {};
  const had = keys[dk.d];
  if (had && (had.u !== uid || had.k !== dk.k)) throw new Error("e2e key conflict");
  if (devs[uid] === dk.d) return { joined: true, already: true };
  if (!had && Object.keys(keys).length >= 300) throw new Error("too many devices");
  const now = Date.now(), prev = devs[uid] || null;
  const f = { e2e: { mapValue: { fields: { devs: { mapValue: { fields: { [uid]: { stringValue: dk.d } } } } } } } }, mask = [fp("e2e", "devs", uid)];
  if (!had) { f.e2e.mapValue.fields.keys = { mapValue: { fields: { [dk.d]: toFsValue({ u: uid, k: dk.k, ts: now }) } } }; mask.push(fp("e2e", "keys", dk.d)); }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: f }, updateMask: { fieldPaths: mask }, currentDocument: { exists: true } }]);
  await sysMsg(token, cid, uid, prev ? "e2e_rekey" : "e2e_join", {});
  return { joined: true, rekey: !!prev };
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
  if (type === "location") {   // v38: إحداثيّاتٌ صحيحة فقط، وتسميةٌ قصيرة
    const lat = Number(out.extra && out.extra.lat), lng = Number(out.extra && out.extra.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new Error("bad location");
    out.extra = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, acc: Math.min(99999, Math.max(0, Math.round(Number(out.extra.acc) || 0))) || null, label: String(out.extra.label || "").slice(0, 120) || null };
    delete out.text;
  }
  // v33: «مرّة واحدة» لا تترك أثراً — لا صورة مصغّرة ولا نصّ الرسالة الصوتيّة
  if (out.extra && out.extra.viewOnce) { delete out.extra.thumb; delete out.extra.transcript; }
  // v33: سقفٌ للرسالة كلّها — رسالةٌ واحدة ضخمة كانت تملأ وثيقة اليوم (١ ميغابايت) فتتعطّل المحادثة حتّى منتصف الليل
  if (JSON.stringify(out).length > 16000) throw new Error("message too large");
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
  const other = type === "dm" ? fsArr(c, "members").find(x => x !== uid) : null;   // C55: فحص الحظر يُقرأ بالتوازي أدناه
  if (type === "group" && fbool(c, "adminsOnly")) {
    if (fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can send here");
  }
  const ts = Date.now(), e2e = e2eOf(c);
  const msg = e2e ? cleanEncMsg(payload.msg, uid, ts, e2e) : cleanMsg(payload.msg, uid, ts);
  let sh = shardOf(c, ts, JSON.stringify(msg).length + 200), day = sh.key;
  const metaP = msg.extra && msg.extra.mid ? fsGet(token, "chats/" + cid + "/media/" + msg.extra.mid) : Promise.resolve(undefined);   // C55
  // v33: معرّف الرسالة لا يُعاد استعماله — كان أيّ عضوٍ يستبدل رسالة غيره (أو رسالة نظام) بإرسال المعرّف نفسه.
  //      المعرّف نفسه من المرسل نفسه = إعادة محاولة ⇒ لا نكتب ثانيةً ولا نرسل إشعاراً مكرّراً.
  //      الاقتباس في الردّ يُؤخذ من الرسالة الأصليّة لا ممّا كتبه المرسل (إن كانت من اليوم أو من يومٍ أرسله العميل)
  const rday = msg.reply && DAY_REF.test(String((payload.msg.reply || {}).day || "")) ? String(payload.msg.reply.day) : day;
  // C55: ثلاث قراءاتٍ بالتوازي بدل ثلاث رحلاتٍ متتالية: الحظر · بيانات الوسيط · رسائل اليوم
  const [pr, meta, peek] = await Promise.all([other ? fsGet(token, "accounts/" + other + "/chatprefs/main") : Promise.resolve(null), metaP,
    dayPeek(token, cid, day, [msg.id].concat(msg.reply && rday === day ? [msg.reply.id] : []))]);
  if (other) {   // الحظر: الطرف الآخر حظرني ⇒ لا تصل (ولا نخبر المرسل — كما في واتساب تبقى ✓ واحدة)
    const blocked = pr && fstr(pr, "data") ? (JSON.parse(fstr(pr, "data")).blocked || []) : [];
    if (blocked.indexOf(uid) >= 0) return { ts: Date.now(), day: null, blocked: true };
  }
  if (msg.extra && msg.extra.mid) {   // الوسيط رفعه المرسل نفسه في هذه المحادثة واكتمل
    if (!meta || fstr(meta, "by") !== uid || !fbool(meta, "done")) throw new Error("media not uploaded");
    msg.extra.size = fsInt(meta, "size"); msg.extra.mime = fstr(meta, "mime") || msg.extra.mime || null;
  }
  if (peek[msg.id]) {
    if (peek[msg.id].by !== uid) throw new Error("message id taken");
    return { ts: peek[msg.id].ts || ts, day, id: msg.id, dup: true };
  }
  if (msg.reply && !e2e) {   // v36: في السرّيّة الاقتباس داخل النصّ المشفّر — الخادم لا يقرؤه
    const orig = rday === day ? peek[msg.reply.id] : (await dayPeek(token, cid, rday, [msg.reply.id]))[msg.reply.id];
    if (orig && !orig.del) msg.reply = { id: msg.reply.id, by: orig.by || null, text: String(orig.text || previewOf(orig) || "").slice(0, 200), day: rday };
    else if (orig && orig.del) msg.reply = { id: msg.reply.id, by: orig.by || null, text: "", day: rday, del: true };
    else if (payload.msg.reply.day) msg.reply = { id: msg.reply.id, by: null, text: "", day: rday, missing: true };
    else msg.reply.unv = true;   // عميلٌ قديم لم يرسل يوم الأصل ⇒ يبقى نصّه موسوماً «غير متحقَّق» (العميل الجديد يرسل اليوم دائماً)
  }
  const dis = fsInt(c, "disappear");
  if (dis > 0) msg.exp = ts + dis * 1000;
  const sendWrites = (sh) => (msg.extra && msg.extra.mid ? [{ delete: DOC_ROOT + "/mediaq/" + cid + "~" + msg.extra.mid }] : []).concat([
    { update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + sh.key, fields: { msgs: { mapValue: { fields: { [msg.id]: toFsValue(msg) } } } } },
      updateMask: { fieldPaths: [fp("msgs", msg.id)] } },
    { update: { name: DOC_ROOT + "/chats/" + cid, fields: {
        last: toFsValue(Object.assign({ id: msg.id, by: uid, type: msg.type, text: e2e ? "" : previewOf(msg), ts: ts, day: sh.key }, e2e ? { e2e: true } : {})),
        updatedTs: { integerValue: String(ts) },
        shard: toFsValue({ day: sh.day, n: sh.n, sz: sh.sz }),
        reads: { mapValue: { fields: { [uid]: { integerValue: String(ts) } } } },
        delivered: { mapValue: { fields: { [uid]: { integerValue: String(ts) } } } } } },
      updateMask: { fieldPaths: ["last", "updatedTs", "shard", fp("reads", uid), fp("delivered", uid)] },
      updateTransforms: [{ fieldPath: "cnt", increment: { integerValue: "1" } }, { fieldPath: fp("readCnt", uid), increment: { integerValue: "1" } }],
      currentDocument: { exists: true } },
  ]);
  try { await fsCommit(token, sendWrites(sh)); }
  catch (e) {   // امتلأ الجزء (تعديلات وتفاعلات كبّرته) ⇒ الجزء التالي
    if (!tooBig(e)) throw e;
    sh = shardOf(c, ts, JSON.stringify(msg).length + 200, sh.n); day = sh.key;
    await fsCommit(token, sendWrites(sh));
  }
  // الإشعارات بعد الردّ (waitUntil) فلا ينتظرها المرسل
  const job = notifyChat(token, c, cid, uid, msg).catch(e => console.log("push:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  if (msg.type === "tasks" && !msg.enc) {   // C173: فهرس «مهامّي»/التذكير + «أُسند إليك»
    const tj = (async () => { await fsCommit(token, [taskIdxWrite(c, cid, day, msg.id, msg)]); await taskAssignPush(token, c, cid, uid, msg, null); })().catch(e => console.log("tasks:", e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(tj); else await tj;
  }
  return { ts, day, id: msg.id };
}
async function dayMsg(token, cid, day, id) {
  if (!DAY_REF.test(String(day || "")) || !MSG_ID.test(String(id || ""))) throw new Error("bad message ref");
  const d = await fsGet(token, "chats/" + cid + "/days/" + day);
  const v = d && d.fields && d.fields.msgs && d.fields.msgs.mapValue.fields && d.fields.msgs.mapValue.fields[id];
  if (!v) throw new Error("message not found");
  return fsToJs(v);
}
// v33: قراءة رسائل بعينها من وثيقة يوم (قناع حقول — لا تُنزَّل الوثيقة كلّها)
async function dayPeek(token, cid, day, ids) {
  ids = [...new Set(ids.filter(id => MSG_ID.test(String(id || ""))))];
  if (!ids.length) return {};
  const q = ids.map(id => "mask.fieldPaths=" + encodeURIComponent(fp("msgs", id))).join("&");
  const res = await fetch(FS_BASE + "/chats/" + cid + "/days/" + day + "?" + q, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 404) return {};
  const d = await res.json();
  if (!res.ok) throw new Error("firestore get: " + JSON.stringify(d).slice(0, 200));
  const f = (d && d.fields && d.fields.msgs && d.fields.msgs.mapValue && d.fields.msgs.mapValue.fields) || {};
  const out = {}; for (const id of ids) if (f[id]) out[id] = fsToJs(f[id]);
  return out;
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
/* v35: حجز الرفع — الجهاز يطلب الإذن قبل رفع أيّ وسيط (القواعد ترفض وسيطاً بلا حجز في mediaq).
   حدٌّ يوميّ لكلّ مستخدم، وما لم يُرسَل خلال ٢٤ ساعة يحذفه الـCron (كانت الرفعات المتروكة تبقى إلى الأبد = تخزينٌ مجّانيّ بلا حدّ). */
const MEDIA_DAY_MAX = 300 * 1024 * 1024;
async function opMediaBegin(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, mid } = payload || {}, size = Math.floor(Number((payload || {}).size) || 0);
  if (!MEDIA_ID.test(String(mid || ""))) throw new Error("bad media id");
  if (!(size > 0 && size <= 16 * 1024 * 1024)) throw new Error("bad size");
  await requireChatMember(token, cid, uid);
  const day = dayKey(Date.now()), q = await fsGet(token, "quota/" + uid).catch(() => null);
  const used = q && fstr(q, "d") === day ? fsInt(q, "bytes") : 0;
  if (used + size > MEDIA_DAY_MAX) throw new Error("media quota");
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/mediaq/" + cid + "~" + mid, fields: { uid: { stringValue: uid }, cid: { stringValue: cid }, mid: { stringValue: mid }, size: { integerValue: String(size) }, ts: { integerValue: String(Date.now()) } } } },
    { update: { name: DOC_ROOT + "/quota/" + uid, fields: { d: { stringValue: day }, bytes: { integerValue: String(used + size) } } } },
  ]);
  return { ok: true, left: MEDIA_DAY_MAX - used - size };
}
// الـCron: رفعاتٌ حُجزت ولم تُرسل خلال ٢٤ ساعة ⇒ تُحذف مع قطعها
async function mediaGc(env, max) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "mediaq" }], where: { fieldFilter: { field: { fieldPath: "ts" }, op: "LESS_THAN", value: { integerValue: String(Date.now() - 86400000) } } }, limit: max || 5 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let n = 0;
  for (const d of rows) {
    const cid = fstr(d, "cid"), mid = fstr(d, "mid");
    try { if (segOk(cid)) await deleteMedia(token, cid, mid); await fsCommit(token, [{ delete: d.name }]); n++; } catch (e) { console.log("mediaGc:", e && e.message); }
  }
  return { gc: n };
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
  if (all) { f.gone = { booleanValue: true }; mask.push(fp("msgs", id, "gone"), fp("msgs", id, "extra", "thumb"), fp("msgs", id, "extra", "transcript"), fp("msgs", id, "enc")); }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: f } } } } } } },
    updateMask: { fieldPaths: mask } }]);
  if (all) await deleteMedia(token, cid, m.extra.mid);   // شاهده الجميع ⇒ يُحذف الوسيط نهائيّاً
  return { gone: all };
}
// v61: المحظور في الخاصّة لا يغيّر شيئاً فيها (تعديل · تفاعل · تثبيت · إعدادات) — كان الحظر في الإرسال وحده
async function dmBlocked(token, c, uid) {
  if (fstr(c, "type") !== "dm") return false;
  const other = fsArr(c, "members").find(u => u !== uid);
  return other ? blockedBy(token, other, uid) : false;
}
async function opChatEdit(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, day, id } = payload || {};
  const c = await requireChatMember(token, cid, uid);
  const m = await dayMsg(token, cid, day, id);
  if (m.by !== uid) throw new Error("only the sender can edit");
  if (m.del) throw new Error("message deleted");
  if (m.type && m.type !== "text") throw new Error("only text can be edited");   // v61
  if (await dmBlocked(token, c, uid)) return { edited: Date.now(), blocked: true };
  const e2e = e2eOf(c);
  if (e2e) {   // v36: التعديل في السرّيّة نصٌّ مشفّرٌ جديد للرسالة نفسها
    if (m.type !== "text") throw new Error("only text can be edited");
    const enc = cleanEnc(payload.enc, uid, e2e), now2 = Date.now();
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day,
      fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { enc: toFsValue(enc), edited: { integerValue: String(now2) } } } } } } } } },
      updateMask: { fieldPaths: [fp("msgs", id, "enc"), fp("msgs", id, "edited")] } }]);
    return { edited: now2 };
  }
  const text = String((payload && payload.text) || "").slice(0, 4000);
  if (!text.trim()) throw new Error("empty message");
  const now = Date.now();
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day,
    fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { text: { stringValue: text }, edited: { integerValue: String(now) } } } } } } } } },
    updateMask: { fieldPaths: [fp("msgs", id, "text"), fp("msgs", id, "edited")] } }]);
  // v61: معاينة قائمة المحادثات تتبع التعديل إن كانت آخر رسالة
  const lf = c.fields && c.fields.last && c.fields.last.mapValue && c.fields.last.mapValue.fields;
  if (lf && lf.id && lf.id.stringValue === id) await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { last: { mapValue: { fields: { text: { stringValue: text.slice(0, 200) } } } } } },
    updateMask: { fieldPaths: ["last.text"] } }]).catch(() => {});
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
    updateMask: { fieldPaths: [fp("msgs", id, "del"), fp("msgs", id, "delBy"), fp("msgs", id, "text"), fp("msgs", id, "extra"), fp("msgs", id, "reply"), fp("msgs", id, "contact"), fp("msgs", id, "re"),
      fp("msgs", id, "votes"), fp("msgs", id, "paid"), fp("msgs", id, "contrib"), fp("msgs", id, "tstate"), fp("msgs", id, "mentions"), fp("msgs", id, "viewed"), fp("msgs", id, "fwd"), fp("msgs", id, "enc")] } }]);
  if (m.type === "tasks") await fsCommit(token, [{ delete: DOC_ROOT + "/tasklists/" + cid + "~" + id }]).catch(() => {});   // C173
  const lastId = c.fields.last && c.fields.last.mapValue && c.fields.last.mapValue.fields && c.fields.last.mapValue.fields.id && c.fields.last.mapValue.fields.id.stringValue;
  if (lastId === id) await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { last: { mapValue: { fields: { del: { booleanValue: true }, text: { stringValue: "" } } } } } },
    updateMask: { fieldPaths: ["last.del", "last.text"] } }]);
  return { deleted: true };
}
async function opChatReact(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { cid, day, id } = payload || {};
  const c = await requireChatMember(token, cid, uid);
  if (!DAY_REF.test(String(day || "")) || !MSG_ID.test(String(id || ""))) throw new Error("bad message ref");
  if (await dmBlocked(token, c, uid)) return { ok: true };   // v61
  const target = (await dayPeek(token, cid, day, [id]))[id];   // v33: لا تفاعل مع رسالةٍ غير موجودة أو محذوفة
  if (!target || !target.by || target.del) throw new Error("message not found");
  const emoji = payload.emoji ? String(payload.emoji).slice(0, 16) : null;
  const f = emoji ? { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { re: { mapValue: { fields: { [uid]: { stringValue: emoji } } } } } } } } } } } : {};
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: f },
    updateMask: { fieldPaths: [fp("msgs", id, "re", uid)] }, currentDocument: { exists: true } }]);
  return { ok: true };
}
async function opChatPin(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  // v33: «المشرفون فقط يعدّلون معلومات المجموعة» يشمل التثبيت
  if (fstr(c, "type") === "group" && (fbool(c, "infoAdminsOnly") || fbool(c, "adminsOnly")) && fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can change this");
  if (await dmBlocked(token, c, uid)) throw new Error("blocked");   // v61
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
  // v33: العضويّة بقراءةٍ واحدة لكلّ المحادثات (batchGet بقناع members) — كان غير العضو يكتب حقوله في أيّ محادثة
  if (!writes.length) return { marked: 0 };
  const names = [...new Set(writes.map(w => w.update.name))];
  const ok = new Set();
  try {
    const res = await fetch(FS_BASE + ":batchGet", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: names, mask: { fieldPaths: ["members", "deleted"] } }) });
    for (const r of (await res.json()) || []) if (r.found && !fbool(r.found, "deleted") && fsArr(r.found, "members").indexOf(uid) >= 0) ok.add(r.found.name);
  } catch (e) { return { marked: 0 }; }
  const mine = writes.filter(w => ok.has(w.update.name));
  if (!mine.length) return { marked: 0 };
  try { await fsCommit(token, mine); return { marked: mine.length }; }
  catch (e) { let n = 0; for (const w of mine) { try { await fsCommit(token, [w]); n++; } catch (e2) {} } return { marked: n }; }
}
async function opChatSettings(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  if (fstr(c, "type") === "group" && fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can change this");
  if (await dmBlocked(token, c, uid)) throw new Error("blocked");   // v61
  // v33: محادثة العائلة — المالك والمحرّرون فقط (كان أيّ عضوٍ يشغّلها)
  if (/^fam_/.test(cid)) {
    const mem = await fsGet(token, "groups/" + cid.slice(4) + "/members/" + uid).catch(() => null);
    if (["owner", "editor"].indexOf(fstr(mem, "role")) < 0) throw new Error("only family editors can change this");
  }
  const allowed = [0, 3600, 86400, 604800, 7776000];
  const dis = Number(payload.disappear || 0);
  if (allowed.indexOf(dis) < 0) throw new Error("bad value");
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { disappear: { integerValue: String(dis) }, disappearBy: { stringValue: uid }, disOn: { booleanValue: true } } }, updateMask: { fieldPaths: ["disappear", "disappearBy", "disOn"] } }]);
  return { disappear: dis };
}
// إعداداتي في المحادثات تتزامن بين أجهزتي: أرشفة، تثبيت، كتم، قفل، مجلّدات، سمات، نغمات، مميّزة، محذوفة عندي، محظورون
const PREF_KEYS = ["archived", "pinned", "muted", "locked", "folders", "folderOf", "themes", "tones", "starred", "hidden", "blocked", "drafts", "cleared", "broadcasts", "nick"];
// التسميات: حتّى ٣٠٠ جهة اتّصال، كلّ اسم ≤ ٤٠ حرفاً
function capNick(v) {
  const o = {}; let n = 0;
  if (v && typeof v === "object" && !Array.isArray(v)) for (const k in v) {
    if (++n > 300) break;
    if (segOk(k) && typeof v[k] === "string" && v[k].trim()) o[k.slice(0, 128)] = v[k].trim().slice(0, 40);
  }
  return o;
}
async function opChatPrefs(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const path = "accounts/" + uid + "/chatprefs/main";
  const cur = await fsGet(token, path);
  let data = {}; try { data = cur && fstr(cur, "data") ? JSON.parse(fstr(cur, "data")) : {}; } catch (e) { data = {}; }
  const set = payload && payload.set;
  if (set && typeof set === "object") {
    if ("muted" in set) await syncMutedBy(token, uid, data.muted, set.muted);
    for (const k of PREF_KEYS) if (k in set) data[k] = k === "nick" ? capNick(set[k]) : capVal(set[k]);
    const json = JSON.stringify(data);
    if (json.length > 200000) throw new Error("prefs too large");
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/" + path, fields: { data: { stringValue: json }, ts: { integerValue: String(Date.now()) } } } }]);
  }
  // الحظر يُنفَّذ أيضاً في قواعد RTDB (blk/{أنا}/{هو}): لا يرى حضوري، ولا يتّصل بي، ولا يرنّ صندوقي
  const bl = Array.isArray(data.blocked) ? data.blocked.filter(x => segOk(String(x))).slice(0, 500) : [];
  if ((set && "blocked" in set) || bl.length) {
    try { await rtdbPatch(token, { ["blk/" + uid]: bl.length ? Object.fromEntries(bl.map(x => [x, true])) : null }); } catch (e) { console.log("blk:", e && e.message); }
    if (set && "blocked" in set && bl.length) { try { await momStrip(token, uid, bl); } catch (e) { console.log("momStrip:", e && e.message); } }   // C133b: المحظور لا يرى لحظاتي السابقة
  }
  return { prefs: data };
}
/* تنظيف الرسائل المؤقّتة (Cron كلّ ١٥ دقيقة): محادثاتٌ فيها disappear > 0 ⇒ يُحذف ما انتهى أجله */
async function cleanupDisappearing(env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  // v35: يمرّ على كلّ المحادثات بالدور (مؤشّرٌ محفوظ في meta/cleanup) — كان يعالج أوّل ١٠ محادثات فقط إلى الأبد.
  //      disOn: كلّ محادثةٍ شُغّلت فيها المؤقّتة (ولو أُطفئت بعدها، لأنّ رسائلها القديمة ما زال لها أجل) حتّى لا يبقى فيها ما له أجل.
  const q = (where, extra) => fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: Object.assign({ from: [{ collectionId: "chats" }], where, limit: 10 }, extra || {}) }) })
    .then(r => r.json()).then(b => (b || []).filter(r => r.document).map(r => r.document)).catch(() => []);
  const metaDoc = await fsGet(token, "meta/cleanup").catch(() => null);
  const cur = fstr(metaDoc, "disCur") || "";
  const eq = { fieldFilter: { field: { fieldPath: "disOn" }, op: "EQUAL", value: { booleanValue: true } } };
  const rows = await q(eq, Object.assign({ orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }] }, cur ? { startAt: { values: [{ referenceValue: cur }], before: false } } : {}));
  // المحادثات القديمة (قبل v35) بلا disOn: مرورٌ واحد على كلّ المحادثات (٥٠ في كلّ دورة) يضمّ ما فيه المؤقّتة إلى الدور، ثمّ يتوقّف
  let legacy = [], legCur = fstr(metaDoc, "legCur") || "", legDone = fbool(metaDoc, "legDone");
  if (!legDone) {
    const all = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: Object.assign({ from: [{ collectionId: "chats" }], select: { fields: [{ fieldPath: "disappear" }, { fieldPath: "disOn" }] },
        orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }], limit: 50 }, legCur ? { startAt: { values: [{ referenceValue: legCur }], before: false } } : {}) }) })
      .then(r => r.json()).then(b => (b || []).filter(r => r.document).map(r => r.document)).catch(() => null);
    if (all) {
      legacy = all.filter(c => fsInt(c, "disappear") > 0 && !fbool(c, "disOn"));
      if (legacy.length) await fsCommit(token, legacy.map(c => ({ update: { name: c.name, fields: { disOn: { booleanValue: true } } }, updateMask: { fieldPaths: ["disOn"] } }))).catch(() => {});
      legCur = all.length ? all[all.length - 1].name : legCur; legDone = all.length < 50;
    }
  }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/meta/cleanup", fields: { disCur: { stringValue: rows.length === 10 ? rows[rows.length - 1].name : "" }, disTs: { integerValue: String(Date.now()) },
    legCur: { stringValue: legCur }, legDone: { booleanValue: legDone } } },
    updateMask: { fieldPaths: ["disCur", "disTs", "legCur", "legDone"] } }]).catch(() => {});
  legacy = [];   // تُعالَج في دورها التالي (صار لها disOn)
  const now = Date.now(); let removed = 0;
  // v33: لا يُحذف إلّا ما له أجلٌ (exp) انقضى — كان اليوم كلّه يُحذف بحسب عمره، فتشغيل «المؤقّتة» يمسح التاريخ القديم كلّه.
  //      الوسائط أوّلاً (حتّى ٥ لكلّ يوم في الدورة)، ولا تُحذف رسالةٌ قبل وسيطها؛ ما بقي يكمل في الدورة التالية.
  for (const c of rows.concat(legacy)) {
    const cid = c.name.split("/").pop();
    const days = await fsList(token, "chats/" + cid + "/days");
    let pending = 0;
    for (const d of days) {
      const msgs = (d.fields && d.fields.msgs && d.fields.msgs.mapValue.fields) || {};
      const ids = Object.keys(msgs);
      const gone = ids.filter(id => { const m = fsToJs(msgs[id]); return m && m.exp && m.exp < now; });
      pending += ids.filter(id => { const m = fsToJs(msgs[id]); return m && m.exp && m.exp >= now; }).length;
      if (!gone.length) continue;
      pending += gone.length;   // ما لم يُحذف في هذه الدورة يُحسب حتّى يُحذف
      let budget = LIM(env).dis; const ready = [];
      for (const id of gone) {
        const m = fsToJs(msgs[id]), mid = m && m.extra && m.extra.mid;
        if (!mid) { ready.push(id); continue; }
        if (budget <= 0) continue;
        budget--;
        try { await deleteMedia(token, cid, mid); ready.push(id); } catch (e) {}
      }
      if (!ready.length) continue;
      pending -= ready.length;
      if (ready.length === ids.length) await fsCommit(token, [{ delete: d.name }]);
      else await fsCommit(token, [{ update: { name: d.name, fields: {} }, updateMask: { fieldPaths: ready.map(id => fp("msgs", id)) } }]);
      removed += ready.length;
      const last = c.fields && c.fields.last && fsToJs(c.fields.last);
      if (last && ready.indexOf(last.id) >= 0) await fsCommit(token, [{ update: { name: c.name, fields: { last: { mapValue: { fields: { del: { booleanValue: true }, text: { stringValue: "" } } } } } },
        updateMask: { fieldPaths: ["last.del", "last.text"] } }]).catch(() => {});
    }
    // المؤقّتة مطفأة ولم يبقَ ما له أجل ⇒ تخرج من الدور
    if (!fsInt(c, "disappear") && pending <= 0) await fsCommit(token, [{ update: { name: c.name, fields: {} }, updateMask: { fieldPaths: ["disOn"] } }]).catch(() => {});
  }
  return { chats: rows.length + legacy.length, removed };
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
  const ts = Date.now(), id = "s" + ts.toString(36) + Math.random().toString(36).slice(2, 7);
  const msg = { id, by: uid, ts, type: "system", extra: Object.assign({ ev }, extra || {}) };
  const w = (day) => [
    { update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [id]: toFsValue(msg) } } } } }, updateMask: { fieldPaths: [fp("msgs", id)] } },
    { update: { name: DOC_ROOT + "/chats/" + cid, fields: { last: toFsValue({ id, by: uid, type: "system", text: "", ts, day, ev }), updatedTs: { integerValue: String(ts) } } },
      updateMask: { fieldPaths: ["last", "updatedTs"] }, currentDocument: { exists: true } },
  ];
  // v35: رسالة النظام تذهب إلى جزء اليوم الحاليّ (من وثيقة المحادثة) — قراءةٌ واحدة فقط إن امتلأ الجزء الأوّل
  try { await fsCommit(token, w(dayKey(ts))); }
  catch (e) {
    if (!tooBig(e)) throw e;
    const c = await chatDoc(token, cid), sh = shardOf(c, ts, 400);
    try { await fsCommit(token, w(sh.key)); } catch (e2) { if (!tooBig(e2)) throw e2; await fsCommit(token, w(shardOf(c, ts, 400, sh.n).key)); }
  }
}
async function requireGroupAdmin(token, cid, uid) {
  const c = await requireChatMember(token, cid, uid);
  if (fstr(c, "type") !== "group") throw new Error("not a group");
  if (fsArr(c, "admins").indexOf(uid) < 0) throw new Error("only admins can do this");
  return c;
}
async function writeMembers(token, cid, members, admins, names, banned) {
  const fields = { members: toFsValue(members), admins: toFsValue(admins), names: toFsValue(names) }, mask = ["members", "admins", "names"];
  if (banned) { fields.banned = toFsValue(banned.slice(-500)); mask.push("banned"); }   // v33: المُزالون لا يعودون برابط الدعوة
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields },
    updateMask: { fieldPaths: mask }, currentDocument: { exists: true } }]);
  await rtdbSetChatMembers(token, cid, members);
}
async function opGroupCreate2(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const name = String((payload && payload.name) || "").trim().slice(0, 80);
  if (!name) throw new Error("name required");
  const want = Array.isArray(payload.members) ? payload.members.filter(x => segOk(String(x)) && x !== uid).slice(0, 100) : [];
  const contacts = await contactSet(token, uid);
  const blk = await blockedSet(token, want.filter(u => u in contacts), uid);   // v61: من حظرني لا أضيفه إلى مجموعة
  const members = [uid].concat(want.filter(u => (u in contacts) && !blk.has(u)));
  const names = { [uid]: memberIdFields(claims).name.stringValue || null };
  members.forEach(u => { if (u !== uid) names[u] = contacts[u]; });
  const cid = "grp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20), now = Date.now();
  const dk = payload.e2e ? await e2eDevKey(payload.e2e) : null;   // v36: مجموعةٌ سرّيّة
  const gf = {
    type: { stringValue: "group" }, name: { stringValue: name }, desc: { stringValue: String(payload.desc || "").slice(0, 500) },
    members: toFsValue(members), admins: toFsValue([uid]), names: toFsValue(names), createdBy: { stringValue: uid },
    createdTs: { integerValue: String(now) }, updatedTs: { integerValue: String(now) }, cnt: { integerValue: "0" }, adminsOnly: { booleanValue: false } };
  if (dk) gf.e2e = toFsValue({ on: true, devs: { [uid]: dk.d }, keys: { [dk.d]: { u: uid, k: dk.k, ts: now } } });
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: gf },
    currentDocument: { exists: false } }]);
  await rtdbSetChatMembers(token, cid, members);
  await sysMsg(token, cid, uid, "created", { name });
  if (dk) await sysMsg(token, cid, uid, "e2e_on", {});
  return { cid, members, skipped: want.filter(u => !(u in contacts) || blk.has(u)) };
}
async function opGroupUpdate(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  const c = await requireChatMember(token, cid, uid);
  // C159: محادثة العائلة — صورتها وحدها، لمالك العائلة ومحرّريها (الاسم والأعضاء يتبعان العائلة)
  if (fstr(c, "type") === "family") {
    if (payload.photo == null || Object.keys(payload).some(k => k !== "cid" && k !== "photo")) throw new Error("family chat follows the family");
    const fm = await fsGet(token, "groups/" + fstr(c, "familyGroupId") + "/members/" + uid).catch(() => null);
    const fr = fstr(fm, "role");
    if (fr !== "owner" && fr !== "editor") throw new Error("only admins can do this");
  } else if (fstr(c, "type") !== "group") throw new Error("not a group");
  const isAdmin = fstr(c, "type") === "family" || fsArr(c, "admins").indexOf(uid) >= 0;
  const fields = {}, mask = [];
  if (payload.name != null || payload.desc != null) {
    if (fbool(c, "infoAdminsOnly") && !isAdmin) throw new Error("only admins can do this");
    if (payload.name != null) { const n = String(payload.name).trim().slice(0, 80); if (!n) throw new Error("name required"); fields.name = { stringValue: n }; mask.push("name"); }
    if (payload.desc != null) { fields.desc = { stringValue: String(payload.desc).slice(0, 500) }; mask.push("desc"); }
  }
  // C155: صورة المجموعة ⇒ avatars/{cid} (كصور الحسابات ≤ ٢٠ ألف حرف) + photoTs في المحادثة
  let gphoto;
  if (payload.photo != null) {
    if (fbool(c, "infoAdminsOnly") && !isAdmin) throw new Error("only admins can do this");
    gphoto = String(payload.photo);
    if (gphoto && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(gphoto) || gphoto.length > 20000)) throw new Error("bad photo");
    fields.photoTs = gphoto ? { integerValue: String(Date.now()) } : { nullValue: null }; mask.push("photoTs");
  }
  for (const k of ["adminsOnly", "infoAdminsOnly"]) if (k in payload) {
    if (!isAdmin) throw new Error("only admins can do this");
    fields[k] = { booleanValue: !!payload[k] }; mask.push(k);
  }
  if (!mask.length) return { ok: true };
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields }, updateMask: { fieldPaths: mask } }].concat(gphoto === undefined ? [] :
    [gphoto ? { update: { name: DOC_ROOT + "/avatars/" + cid, fields: { d: { stringValue: gphoto }, ts: { integerValue: String(Date.now()) } } } } : { delete: DOC_ROOT + "/avatars/" + cid }]));
  if (gphoto !== undefined) await sysMsg(token, cid, uid, "photo", { on: !!gphoto });
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
    const blk = await blockedSet(token, add.filter(u => (u in contacts) && members.indexOf(u) < 0), uid);   // v61
    added = add.filter(u => (u in contacts) && members.indexOf(u) < 0 && !blk.has(u));
    added.forEach(u => { members.push(u); names[u] = contacts[u]; });
  }
  const removed = remove.filter(u => members.indexOf(u) >= 0);
  members = members.filter(u => removed.indexOf(u) < 0); admins = admins.filter(u => removed.indexOf(u) < 0);
  if (!added.length && !removed.length) return { added, removed };
  let banned = fsArr(c, "banned").filter(u => added.indexOf(u) < 0);   // إضافة المشرف تلغي المنع
  removed.forEach(u => { if (banned.indexOf(u) < 0) banned.push(u); });
  await writeMembers(token, cid, members, admins, names, banned);
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
  if (fsArr(c, "banned").indexOf(uid) >= 0) throw new Error("removed from this group");   // v33: أزاله مشرف ⇒ لا يعود إلّا بإضافة مشرف
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
/* v35: الاستطلاع المجهول مجهولٌ فعلاً — الصوت يُخزَّن تحت مفتاحٍ مشتقّ (HMAC بسرّ الخادم) لا يُعرف منه صاحبه،
   وصوتٌ واحد لكلّ عضو كما كان. الجهاز يعرف مفتاحه هو فقط (chat.pollKeys) ليُظهر اختياره. */
/* v65 (C111): إقرار الجهاز بلا رمز دخول — التطبيق الأصليّ يستلم الإشعار والتطبيق مغلق فلا يملك رمز Firebase.
   الخادم يوقّع في الإشعار نفسه (HMAC بسرّ الخادم) ما يُسمح بإقراره: «رنّت المكالمة» أو «وصلت الرسالة»؛ فلا يُقرّ أحدٌ عن غيره. */
let ackHmac = null;
async function ackSig(env, s) {
  if (!ackHmac) ackHmac = await crypto.subtle.importKey("raw", new TextEncoder().encode((JSON.parse(env.SA_JSON).private_key || "") + "|ack"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", ackHmac, new TextEncoder().encode(s)));
  let b = ""; for (let i = 0; i < 16; i++) b += sig[i].toString(16).padStart(2, "0");
  return b;
}
/* C152: صورة حساب المرسِل لإشعار أندرويد (كإشعارات انستجرام) — بلا رمز دخول (الإشعار يصل والتطبيق مغلق)،
   لكن برابطٍ موقَّع (ak = HMAC "av|uid") لا يصدر إلّا داخل إشعارٍ من ذلك المرسِل ⇒ لا تعداد للصور. */
async function avatarImg(request, env) {
  const q = new URL(request.url).searchParams, u = String(q.get("u") || ""), sg = String(q.get("s") || "");
  if (!segOk(u) || !/^[0-9a-f]{32}$/.test(sg) || sg !== await ackSig(env, "av|" + u)) return new Response("", { status: 403 });
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await fsGet(token, "avatars/" + u).catch(() => null);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(fstr(doc, "d") || "");
  if (!m) return new Response("", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bin, { headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
async function deviceAck(request, env) {
  let b = {}; try { b = await request.json(); } catch (e) {}
  const k = String(b.k || ""), to = String(b.to || ""), sg = String(b.s || "");
  if (!segOk(to) || !/^[0-9a-f]{32}$/.test(sg)) return json({ ok: false }, 400);
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  if (k === "r") {   // المكالمة رنّت على جهازه
    const call = String(b.call || "");
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(call) || sg !== await ackSig(env, "r|" + call + "|" + to)) return json({ ok: false }, 403);
    const c = await rtdbGet(token, "calls/" + call).catch(() => null);
    if (c && c.to === to && c.state === "ringing" && !c.rung) await rtdbPatch(token, { ["calls/" + call + "/rung"]: Date.now() });
    stat("ack:ring");
    return json({ ok: true });
  }
  if (k === "x") {   // C142: «رفض» من إشعار الهاتف والتطبيق مغلق — كان المتّصل يبقى «يرنّ…» حتّى تنتهي المهلة
    const call = String(b.call || "");
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(call) || sg !== await ackSig(env, "r|" + call + "|" + to)) return json({ ok: false }, 403);
    const c = await rtdbGet(token, "calls/" + call).catch(() => null);
    if (c && c.to === to && c.state === "ringing" && !c.acc) await rtdbPatch(token, { ["calls/" + call + "/state"]: "declined" });
    stat("ack:decline");
    return json({ ok: true });
  }
  if (k === "d") {   // الرسالة وصلت جهازه
    const cid = String(b.cid || ""), ts = Math.floor(Number(b.ts || 0));
    if (!segOk(cid) || !(ts > 0) || sg !== await ackSig(env, "d|" + cid + "|" + to + "|" + ts)) return json({ ok: false }, 403);
    const c = await fsGet(token, "chats/" + cid).catch(() => null);
    const cur = Number((((c && c.fields && c.fields.delivered && c.fields.delivered.mapValue && c.fields.delivered.mapValue.fields) || {})[to] || {}).integerValue || 0);
    if (c && ts > cur) await opChatMark(to, { marks: [{ cid, d: ts }] }, env);
    stat("ack:deliv");
    return json({ ok: true });
  }
  return json({ ok: false }, 400);
}
let pollHmac = null;
async function anonKey(env, uid, cid, id) {
  if (!pollHmac) {
    const secret = env.POLL_SECRET || (JSON.parse(env.SA_JSON).private_key || "") + "|poll";
    pollHmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", pollHmac, new TextEncoder().encode(uid + "|" + cid + "|" + id)));
  let b = ""; for (let i = 0; i < 12; i++) b += sig[i].toString(16).padStart(2, "0");
  return "a" + b;
}
async function opChatVote(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { m, cid, day, id } = await toolMsg(token, payload, uid, "poll");
  const ex = m.extra || {};
  if (ex.deadline && Date.now() > ex.deadline) throw new Error("poll closed");
  const opt = payload.option == null ? null : Number(payload.option);
  if (opt != null && !(Number.isInteger(opt) && opt >= 0 && opt < (ex.options || []).length)) throw new Error("bad option");
  if (ex.anonymous) {
    const key = await anonKey(env, uid, cid, id);
    const w = [setPath(cid, day, ["msgs", id, "votes", key], opt == null ? undefined : opt)];
    if (m.votes && uid in m.votes) w.push(setPath(cid, day, ["msgs", id, "votes", uid], undefined));   // صوتٌ قديم باسمه (قبل v35) يُمحى
    await fsCommit(token, w);
    return { ok: true, key };
  }
  await fsCommit(token, [setPath(cid, day, ["msgs", id, "votes", uid], opt == null ? undefined : opt)]);
  return { ok: true };
}
async function opChatPollKeys(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const cid = payload && payload.cid;
  await requireChatMember(token, cid, uid);
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).filter(x => MSG_ID.test(String(x))).slice(0, 50);
  const keys = {};
  for (const id of ids) keys[id] = await anonKey(env, uid, cid, id);
  return { keys };
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
async function opChatTask(uid, payload, env, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { c, m, cid, day, id } = await toolMsg(token, payload, uid, "tasks");
  const taskId = String(payload.taskId || "");
  // C164: في السرّيّة لا يرى الخادم المهامّ (داخل enc) — معرّفٌ سليم فقط، والحالة وحدها (لا ملاحظات نصّيّة ظاهرة)
  let task = null;
  if (m.enc) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(taskId)) throw new Error("task not found");
    if (payload.note != null) throw new Error("notes are not available in secret chats");
  } else if (!(task = ((m.extra && m.extra.tasks) || []).find(t => t.id === taskId))) throw new Error("task not found");
  // C173: الصلاحيّات — منشئ القائمة والمشرف: كلّ شيء · المسؤول: حالته وتخلّيه · مهمّة «لأيّ عضو»: يتولّاها أو يُنجزها أيّ عضو
  const admin = (fstr(c, "type") === "group" || fstr(c, "type") === "family") && fsArr(c, "admins").indexOf(uid) >= 0;
  const boss = m.by === uid || admin;
  const cur = (m.tstate && m.tstate[taskId]) || {};
  const effOf = (s) => task ? taskEff({ tstate: { [taskId]: s } }, task) : (s.owner || null);
  const eff0 = effOf(cur);
  const next = Object.assign({}, cur, { by: uid, ts: Date.now() });
  if (payload.owner !== undefined) {   // إعادة إسناد (المنشئ/المشرف) — "" = لأيّ عضو
    if (!boss) throw new Error("only the creator can reassign");
    const o = String(payload.owner || "");
    if (o && (!segOk(o) || fsArr(c, "members").indexOf(o) < 0)) throw new Error("not a member");
    next.owner = o;
  }
  if (payload.claim === true) { if (eff0 && eff0 !== uid) throw new Error("already assigned"); next.owner = uid; }
  if (payload.claim === false) { if (eff0 !== uid && !boss) throw new Error("not yours"); next.owner = ""; }
  if (payload.status === "done" || payload.status === "pending") {
    if (!m.enc && eff0 && eff0 !== uid && !boss) throw new Error("only the assignee can change this task");
    next.status = payload.status;
    if (payload.status === "done") { next.doneBy = uid; next.doneAt = Date.now(); if (!eff0 && !m.enc && payload.owner === undefined) next.owner = uid; }
    else { delete next.doneBy; delete next.doneAt; }
  }
  if (payload.note != null) next.note = String(payload.note).slice(0, 300);
  if (payload.pct !== undefined) {   // C188: نسبة إنجاز المهمّة 0–100 — يُغيّرها المسؤول (أو المنشئ/المشرف)
    if (!m.enc && eff0 && eff0 !== uid && !boss) throw new Error("only the assignee can change this task");
    const v = Math.round(Number(payload.pct));
    if (!(v >= 0 && v <= 100)) throw new Error("bad pct");
    next.pct = v;
  }
  const m2 = Object.assign({}, m, { tstate: Object.assign({}, m.tstate, { [taskId]: next }) });
  await fsCommit(token, [setPath(cid, day, ["msgs", id, "tstate", taskId], next)].concat(m.enc ? [] : [taskIdxWrite(c, cid, day, id, m2)]));
  // الإشعارات بعد الردّ
  const job = (async () => {
    const names = chatNames(c), who = names[uid] || "سوا", gname = fstr(c, "name") || "سوا";
    const eff1 = effOf(next);
    if (eff1 && eff1 !== uid && eff1 !== eff0 && next.status !== "done")
      await taskPush(token, c, cid, [eff1], "📌 " + who + " أسند إليك مهمّة · " + gname, task ? task.text : "مهمّة مشفّرة 🔒");
    if (payload.status === "done" && cur.status !== "done" && m.by && m.by !== uid) {
      const all = !m.enc && ((m.extra && m.extra.tasks) || []).every(t => ((m2.tstate[t.id] || {}).status) === "done");
      await taskPush(token, c, cid, [m.by], all ? "🎉 اكتملت قائمة «" + ((m.extra && m.extra.title) || "") + "»" : "✓ " + who + " أنجز مهمّة · " + gname, task ? task.text : "🔒");
    }
  })().catch(e => console.log("taskpush:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return { ok: true, state: next };
}

// C173: المهامّ — المسؤول الفعليّ (tstate.owner يغلب assigneeId؛ "" = لأيّ عضو) · فهرس tasklists لشاشة «مهامّي» والتذكير · الإشعارات
const T_H = 3600000, T_S1 = 15 * T_H, T_S2 = 31 * T_H;   // الموعد يوم (منتصف ليل UTC): تذكير قبله بيوم ضحىً · «تأخّرت» صباح اليوم التالي
function taskEff(m, t) { const s = (m.tstate && m.tstate[t.id]) || {}; return s.owner !== undefined && s.owner !== null ? (s.owner || null) : (t.assigneeId || null); }
function taskRemStage(s, t) { const r = String((s && s.rem) || "").split(":"); return r[0] === String(t.dueAt) ? Number(r[1]) || 0 : 0; }
function taskRemNext(m) {
  let rq = 0; const ts = m.tstate || {};
  for (const t of (m.extra && m.extra.tasks) || []) {
    const s = ts[t.id] || {}; if (s.status === "done" || !(Number(t.dueAt) > 0) || !taskEff(m, t)) continue;
    const st = taskRemStage(s, t), at = st < 1 ? t.dueAt - T_S1 : st < 2 ? t.dueAt + T_S2 : 0;
    if (at && (!rq || at < rq)) rq = at;
  }
  return rq;
}
function taskIdxWrite(c, cid, day, id, m) {
  const name = DOC_ROOT + "/tasklists/" + cid + "~" + id;
  if (!m || m.del || m.enc || !(m.extra && Array.isArray(m.extra.tasks))) return { delete: name };
  const ts = m.tstate || {};
  const tasks = m.extra.tasks.slice(0, 50).map(t => { const s = ts[t.id] || {}; return { id: t.id, text: String(t.text || "").slice(0, 300), a: taskEff(m, t), due: Number(t.dueAt) > 0 ? Number(t.dueAt) : null,
    st: s.status === "done" ? "done" : "pending", note: String(s.note || "").slice(0, 300), db: s.doneBy || null, da: s.doneAt || null }; });
  if (!tasks.some(t => t.st !== "done")) return { delete: name };
  const users = [...new Set([m.by].concat(tasks.map(t => t.a)).filter(Boolean))].slice(0, 60);
  return { update: { name, fields: toFsValue({ cid, day, id, by: m.by || null, title: String((m.extra && m.extra.title) || "").slice(0, 200), users, tasks, ts: Number(m.ts) || Date.now(), rq: taskRemNext(m) }).mapValue.fields } };
}
function chatNames(c) { return fsToJs((c.fields || {}).names || { nullValue: null }) || {}; }
async function taskPush(token, c, cid, uids, title, body) {
  const members = fsArr(c, "members"), muted = fsArr(c, "mutedBy");
  const to = [...new Set(uids)].filter(u => u && members.indexOf(u) >= 0 && muted.indexOf(u) < 0);
  if (!to.length) return 0;
  return pushTo(token, to, strData({ t: "task", cid, title, body: String(body || "").slice(0, 300), ts: Date.now() }));
}
// إشعار «أُسندت إليك» لمن صار مسؤولاً جديداً (لا المرسل نفسه)
async function taskAssignPush(token, c, cid, uid, m, before) {
  if (m.enc) return 0;
  const names = chatNames(c), gname = fstr(c, "name") || "سوا", by = names[uid] || "سوا";
  const per = {};
  for (const t of (m.extra && m.extra.tasks) || []) {
    const a = taskEff(m, t); if (!a || a === uid) continue;
    if (before && before[t.id] === a) continue;
    if (((m.tstate || {})[t.id] || {}).status === "done") continue;
    (per[a] = per[a] || []).push(t.text);
  }
  let n = 0;
  for (const u of Object.keys(per).slice(0, LIM(notifyChat.env).task)) {
    const l = per[u];
    n += await taskPush(token, c, cid, [u], "📌 " + by + " أسند إليك " + (l.length > 1 ? l.length + " مهامّ" : "مهمّة") + " · " + gname, l.slice(0, 3).join(" · ") + (l.length > 3 ? " …" : ""));
  }
  return n;
}
function taskEffMap(m) { const o = {}; for (const t of (m.extra && m.extra.tasks) || []) o[t.id] = taskEff(m, t); return o; }

// إضافة مهمّة سريعة من البطاقة — أيّ عضو (غير السرّيّة؛ في السرّيّة يضيف المنشئ/المشرف عبر التعديل المشفّر)
async function opChatTaskAdd(uid, payload, env, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { c, m, cid, day, id } = await toolMsg(token, payload, uid, "tasks");
  if (m.enc || e2eOf(c)) throw new Error("use edit in secret chats");
  const text = String(payload.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) throw new Error("empty task");
  const tasks = ((m.extra && m.extra.tasks) || []).slice();
  if (tasks.length >= 50) throw new Error("too many tasks");
  const a = segOk(String(payload.assigneeId || "")) && fsArr(c, "members").indexOf(String(payload.assigneeId)) >= 0 ? String(payload.assigneeId) : null;
  const names = chatNames(c);
  const t = { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, assigneeId: a, assigneeName: a ? String(names[a] || "").slice(0, 80) : "", dueAt: Number(payload.dueAt) > 0 ? Number(payload.dueAt) : null, addedBy: uid };
  tasks.push(t);
  const extra = Object.assign({}, m.extra, { tasks });
  const m2 = Object.assign({}, m, { extra });
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { extra: toFsValue(capVal(extra)) } } } } } } } },
    updateMask: { fieldPaths: [fp("msgs", id, "extra")] } }, taskIdxWrite(c, cid, day, id, m2)]);
  const job = taskAssignPush(token, c, cid, uid, m2, taskEffMap(m)).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return { task: t };
}

// «مهامّي»: القوائم المفتوحة التي أنا منشئها أو مسؤولٌ فيها (غير السرّيّة) — استعلامٌ واحد + عضويّة بقراءةٍ واحدة
async function opChatMyTasks(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "tasklists" }],
      where: { fieldFilter: { field: { fieldPath: "users" }, op: "ARRAY_CONTAINS", value: { stringValue: uid } } }, limit: 80 } }) });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore query: " + JSON.stringify(data).slice(0, 200));
  const rows = (data || []).filter(r => r.document).map(r => fsToJs({ mapValue: { fields: r.document.fields || {} } }));
  const cids = [...new Set(rows.map(r => r.cid).filter(x => segOk(String(x || ""))))];
  const chats = {};
  if (cids.length) {
    const r2 = await fetch(FS_BASE + ":batchGet", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: cids.map(x => DOC_ROOT + "/chats/" + x), mask: { fieldPaths: ["members", "deleted", "name", "type", "admins"] } }) });
    for (const r of (await r2.json()) || []) if (r.found && !fbool(r.found, "deleted") && fsArr(r.found, "members").indexOf(uid) >= 0)
      chats[r.found.name.split("/").pop()] = { name: fstr(r.found, "name") || "", type: fstr(r.found, "type") || "", admin: fsArr(r.found, "admins").indexOf(uid) >= 0 };
  }
  const lists = rows.filter(r => chats[r.cid]).map(r => ({ cid: r.cid, chat: chats[r.cid].name, admin: chats[r.cid].admin, day: r.day, id: r.id, by: r.by, title: r.title, ts: r.ts,
    tasks: (r.tasks || []).map(t => ({ id: t.id, text: t.text, assigneeId: t.a || null, dueAt: t.due || null, status: t.st, note: t.note || "", doneBy: t.db || null, doneAt: t.da || null })) }));
  return { lists };
}

// التذكير (من المجدوِل): قائمةٌ واحدة في كلّ تشغيل
async function taskReminders(env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const now = Date.now();
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "tasklists" }], where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "rq" }, op: "GREATER_THAN", value: { integerValue: "0" } } },
      { fieldFilter: { field: { fieldPath: "rq" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } }] } }, limit: LIM(env).rem + 1 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let sent = 0;
  for (const d of rows.slice(0, LIM(env).rem)) {
    const x = fsToJs({ mapValue: { fields: d.fields || {} } });
    let c = null, m = null;
    try { c = await fsGet(token, "chats/" + x.cid); m = await dayMsg(token, x.cid, x.day, x.id); } catch (e) {}
    if (!c || !m || m.del) { await fsCommit(token, [{ delete: d.name }]).catch(() => {}); continue; }
    const names = chatNames(c), gname = fstr(c, "name") || "سوا", ts = Object.assign({}, m.tstate), writes = [];
    const soon = {}, late = {}, lateBy = [];
    for (const t of (m.extra && m.extra.tasks) || []) {
      const s = ts[t.id] || {}, a = taskEff(m, t);
      if (s.status === "done" || !(Number(t.dueAt) > 0) || !a) continue;
      const st = taskRemStage(s, t);
      if (st < 2 && now >= t.dueAt + T_S2) { (late[a] = late[a] || []).push(t.text); lateBy.push((names[a] || "") + ": " + t.text); ts[t.id] = Object.assign({}, s, { rem: t.dueAt + ":2" }); }
      else if (st < 1 && now >= t.dueAt - T_S1) { (soon[a] = soon[a] || []).push(t.text); ts[t.id] = Object.assign({}, s, { rem: t.dueAt + ":1" }); }
      else continue;
      writes.push(setPath(x.cid, x.day, ["msgs", x.id, "tstate", t.id, "rem"], ts[t.id].rem));
    }
    const m2 = Object.assign({}, m, { tstate: ts });
    writes.push(taskIdxWrite(c, x.cid, x.day, x.id, m2));
    await fsCommit(token, writes).catch(e => console.log("taskrem:", e && e.message));   // أوّلاً: لا تكرار
    for (const u of Object.keys(soon).slice(0, 8)) sent += await taskPush(token, c, x.cid, [u], "⏰ موعد مهمّتك قريب · " + gname, soon[u].slice(0, 3).join(" · "));
    for (const u of Object.keys(late).slice(0, 8)) sent += await taskPush(token, c, x.cid, [u], "⚠️ تأخّرت مهمّتك · " + gname, late[u].slice(0, 3).join(" · "));
    if (lateBy.length && m.by && !late[m.by]) sent += await taskPush(token, c, x.cid, [m.by], "⚠️ تأخّرت مهامّ في «" + ((m.extra && m.extra.title) || "") + "»", lateBy.slice(0, 3).join(" · "));
  }
  return { reminders: rows.length, sent };
}

// C164: تعديل قائمة المهامّ — منشئها أو مشرف المجموعة · تبقى حالة المهامّ التي بقيت · في السرّيّة: محتوى مشفّرٌ جديد للرسالة نفسها
async function opChatTasksEdit(uid, payload, env, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const { c, m, cid, day, id } = await toolMsg(token, payload, uid, "tasks");
  const admin = (fstr(c, "type") === "group" || fstr(c, "type") === "family") && fsArr(c, "admins").indexOf(uid) >= 0;
  if (m.by !== uid && !admin) throw new Error("only the creator can edit");
  const now = Date.now(), base = DOC_ROOT + "/chats/" + cid + "/days/" + day;
  const e2e = e2eOf(c);
  if (e2e || m.enc) {
    if (!e2e) throw new Error("not a secret chat");
    const enc = cleanEnc(payload.enc, uid, e2e);
    await fsCommit(token, [{ update: { name: base, fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { enc: toFsValue(enc), edited: { integerValue: String(now) } } } } } } } } },
      updateMask: { fieldPaths: [fp("msgs", id, "enc"), fp("msgs", id, "edited")] } }]);
    return { edited: now };
  }
  const title = String(payload.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const tasks = (Array.isArray(payload.tasks) ? payload.tasks : []).slice(0, 50).map(t => ({
    id: /^[A-Za-z0-9_-]{1,40}$/.test(String(t && t.id || "")) ? String(t.id) : "t" + Math.random().toString(36).slice(2, 10),
    text: String(t && t.text || "").slice(0, 300), assigneeId: segOk(String(t && t.assigneeId || "")) ? String(t.assigneeId) : null,
    assigneeName: String(t && t.assigneeName || "").slice(0, 80), dueAt: Number(t && t.dueAt) > 0 ? Number(t.dueAt) : null })).filter(t => t.text.trim());
  if (!title || !tasks.length) throw new Error("title and one task required");
  // C173: تبقى «أضافها» للمهامّ التي بقيت
  const oldT = {}; for (const t of (m.extra && m.extra.tasks) || []) oldT[t.id] = t;
  tasks.forEach(t => { if (oldT[t.id] && oldT[t.id].addedBy) t.addedBy = oldT[t.id].addedBy; });
  const extra = Object.assign({}, m.extra, { title, tasks, editedAt: now });
  const m2 = Object.assign({}, m, { extra });
  // C173: تغيير المسؤول في التعديل يُلغي التولّي/الإسناد السابق لتلك المهمّة
  const tsw = [];
  for (const t of tasks) { const o = oldT[t.id], s = (m.tstate || {})[t.id]; if (o && s && s.owner !== undefined && (o.assigneeId || null) !== (t.assigneeId || null)) { m2.tstate = Object.assign({}, m2.tstate, { [t.id]: Object.assign({}, s) }); delete m2.tstate[t.id].owner; tsw.push(fp("msgs", id, "tstate", t.id, "owner")); } }
  await fsCommit(token, [{ update: { name: base, fields: { msgs: { mapValue: { fields: { [id]: { mapValue: { fields: { extra: toFsValue(capVal(extra)), edited: { integerValue: String(now) } } } } } } } } },
    updateMask: { fieldPaths: [fp("msgs", id, "extra"), fp("msgs", id, "edited")].concat(tsw) } }, taskIdxWrite(c, cid, day, id, m2)]);
  const job = taskAssignPush(token, c, cid, uid, m2, taskEffMap(m)).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return { edited: now };
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
    token: { stringValue: t }, ua: { stringValue: String(payload.ua || "").slice(0, 160) }, ts: { integerValue: String(Date.now()) },
    lang: { stringValue: payload.lang === "en" ? "en" : "ar" },   // v68: لغة إشعارات هذا الجهاز = لغة التطبيق
    noav: { booleanValue: payload.noav === true },   // C164: «صور المرسلين في الإشعارات» مطفأة على هذا الجهاز
    // C151: رمز VoIP للآيفون (CallKit) وبيئته
    voip: { stringValue: /^[0-9a-f]{40,200}$/i.test(String(payload.voip || "")) ? String(payload.voip) : "" },
    voipEnv: { stringValue: payload.voipEnv === "development" ? "development" : "production" } } } }]);
  // C60: تنظيف — الأجهزة الأقدم من ٦٠ يوماً أو الزائدة عن الحدّ تُحذف (الرموز القديمة تموت غالباً، والمستخدم العاديّ له جهازٌ أو جهازان)
  try {
    const devs = await devsOf(token, uid), now = Date.now();
    const old = devs.filter((d, i) => d.name.split("/").pop() !== id && (i >= DEV_MAX || now - devTs(d) > DEV_TTL)).slice(0, 20);
    if (old.length) await fsCommit(token, old.map(d => ({ delete: d.name }))).catch(() => {});
  } catch (e) {}
  return { id };
}
// v57: «هل هذا الجهاز ما زال مسجّلاً؟» — يسأله التطبيق عند كلّ فتح (كلّ ٢٠ دقيقة على الأكثر)؛ إن لم يجده الخادم يسجّله فوراً (إصلاحٌ ذاتيّ)
async function opPushCheck(uid, payload, env) {
  const t = String((payload && payload.token) || "");
  if (t.length < 20 || t.length > 4096) throw new Error("bad token");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await fsGet(token, "accounts/" + uid + "/devices/" + (await tokenId(t)));
  if (doc && fstr(doc, "token") === t) {
    if (Date.now() - devTs(doc) > 86400000) await fsCommit(token, [{ update: { name: doc.name, fields: { ts: { integerValue: String(Date.now()) } } }, updateMask: { fieldPaths: ["ts"] } }]).catch(() => {});
    return { had: true };
  }
  await opPushRegister(uid, payload, env);
  stat("push:heal");
  return { had: false, healed: true };
}
// C56: إشعارٌ تجريبيّ إلى أجهزتي أنا مع نتيجة كلّ جهاز (يكشف أين تنقطع السلسلة: لا جهاز مسجّل · رمزٌ ميّت · خطأ FCM)
async function opPushTest(uid, payload, env, ctx) {
  if (!codeRate(uid, "ptest", 12)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const devs = await devsOf(token, uid);
  const now = Date.now(), results = [];
  if (payload && payload.dry) return { devices: devs.length, results: [], tails: devs.slice(0, DEV_MAX).map(d => ({ tail: fstr(d, "token").slice(-8), ua: fstr(d, "ua").slice(0, 60), ts: fsInt(d, "ts") })) };   // v54
  // C71: «بعد ١٥ ثانية» — ليغلق المستخدم التطبيق ويرى هل يصله الإشعار في الخلفيّة (حالة الشكوى الحقيقيّة)
  if (payload && payload.delay && ctx && ctx.waitUntil) {
    const ms = Math.min(20000, Math.max(5000, Number(payload.delay) || 15000));
    ctx.waitUntil((async () => {
      await new Promise((r) => setTimeout(r, ms));
      const callTest = payload.kind === "call";   // v55: اختبار «مكالمة» حقيقيّ الشكل (t=call) — يرنّ كما ترنّ المكالمة
      for (const d of devs.slice(0, DEV_MAX)) await fcmSend(token, fstr(d, "token"), (x => x)(strData(callTest
        ? { t: "call", call: "test_" + Date.now().toString(36), from: uid, type: "audio", title: "سوا — اختبار مكالمة", body: "📞 مكالمة تجريبيّة", ts: Date.now(), ring: "0" }
        : { t: "test", title: "سوا — إشعار في الخلفيّة ✓", body: "وصل والتطبيق مغلق — الإشعارات والمكالمات ستصلك.", ts: Date.now() })), fstr(d, "lang")).catch(() => {});
      stat("push:test-bg");
    })());
    return { devices: devs.length, queued: true, delay: ms };
  }
  for (const d of devs.slice(0, DEV_MAX)) {
    const dev = fstr(d, "token"), en = fstr(d, "lang") === "en";
    const tdata = langData({ t: "test", title: "سوا — إشعار تجريبيّ ✓", body: "وصل الإشعار إلى هذا الجهاز. الرسائل والمكالمات ستصلك والتطبيق مغلق.", ts: now }, en);
    const res = await fetch("https://fcm.googleapis.com/v1/projects/" + PROJECT_ID + "/messages:send", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token: dev, data: strData(tdata),
        android: { priority: "HIGH", ttl: "120s" },
        webpush: { headers: { Urgency: "high", TTL: "120" } }, apns: apnsOf(tdata) } }) });
    let err = "";
    if (!res.ok) { const txt = await res.text(); err = (txt.match(/"message":\s*"([^"]{1,160})"/) || [])[1] || ("HTTP " + res.status); if (/UNREGISTERED|registration-token-not-registered|NOT_FOUND/.test(txt)) { await fsCommit(token, [{ delete: d.name }]).catch(() => {}); err = "gone"; } }
    results.push({ ua: fstr(d, "ua").slice(0, 60), ts: fsInt(d, "ts"), ok: res.ok, err, tail: dev.slice(-8) });   // v54: ليعرف الهاتف «هذا أنا»
  }
  stat("push:test");
  return { devices: devs.length, results };
}
async function opPushUnregister(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = String((payload && payload.token) || "");
  if (!t) return { ok: true };
  await fsCommit(token, [{ delete: DOC_ROOT + "/accounts/" + uid + "/devices/" + (await tokenId(t)) }]).catch(() => {});
  return { ok: true };
}
// v67 (C123): تطبيق iOS — APNs لا يُظهر رسائل البيانات الصامتة والتطبيق مغلق، فنرفق تنبيهاً مرئيّاً (يتجاهله أندرويد والمتصفّح).
//   collapse-id: رنّات المكالمة المتكرّرة تحلّ محلّ بعضها بدل تكديس إشعارات · thread-id: يجمع إشعارات المحادثة الواحدة
// v68: إشعاراتٌ بالإنجليزيّة لمن اختار الإنجليزيّة في التطبيق — النصوص الثابتة تُترجم والأسماء ونصّ الرسالة تبقى كما هي
const EN_RULES = [
  [/^سوا — إشعار تجريبيّ ✓$/, "Sawa — test notification ✓"],
  [/^وصل الإشعار إلى هذا الجهاز\..*$/, "This device received the notification. Messages and calls will reach you even when the app is closed."],
  [/^وصل الإشعار إلى هذا الجهاز\.$/, "This device received the notification."],
  [/^سوا — إشعار في الخلفيّة ✓$/, "Sawa — background notification ✓"],
  [/^وصل والتطبيق مغلق.*$/, "Received while the app was closed — notifications and calls will reach you."],
  [/^سوا — اختبار مكالمة$/, "Sawa — call test"], [/^📞 مكالمة تجريبيّة$/, "📞 Test call"],
  [/^🔒 رسالة مشفّرة$/, "🔒 Encrypted message"], [/^📷 صورة$/, "📷 Photo"], [/^🎥 فيديو$/, "🎥 Video"], [/^🎤 رسالة صوتيّة$/, "🎤 Voice message"],
  [/^📎 ملفّ$/, "📎 File"], [/^📊 استطلاع$/, "📊 Poll"], [/^🧾 فاتورة$/, "🧾 Bill"], [/^💝 تبرّعات$/, "💝 Fundraiser"], [/^✅ مهامّ$/, "✅ Tasks"],
  [/^👤 جهة اتّصال$/, "👤 Contact"], [/^📍 موقع$/, "📍 Location"],
  [/^(.*): 🔒 رسالة مشفّرة$/, "$1: 🔒 Encrypted message"], [/^(.*): 📷 صورة$/, "$1: 📷 Photo"], [/^(.*): 🎥 فيديو$/, "$1: 🎥 Video"], [/^(.*): 🎤 رسالة صوتيّة$/, "$1: 🎤 Voice message"], [/^(.*): 📎 ملفّ$/, "$1: 📎 File"],
  [/^(.*) أشار إليك في لحظة$/, "$1 mentioned you in a moment"], [/^(.*) أشار إليك في تعليق$/, "$1 mentioned you in a comment"],   // C135
  [/^(.*) ردّ على تعليقك$/, "$1 replied to your comment"], [/^(.*) تفاعل مع لحظتك$/, "$1 reacted to your moment"], [/^(.*) أعجبه تعليقك$/, "$1 liked your comment"],
  [/^(.*) أشار إليك في (.*)$/, "$1 mentioned you in $2"], [/^(.*) أشار إليك$/, "$1 mentioned you"],
  [/^📹 مكالمة فيديو واردة(.*)$/, "📹 Incoming video call$1"], [/^📞 مكالمة صوتيّة واردة(.*)$/, "📞 Incoming voice call$1"],
  [/^📹 مكالمة فيديو فائتة$/, "📹 Missed video call"], [/^📞 مكالمة فائتة$/, "📞 Missed call"],
  [/^(📹 |📞 )(.*) يدعوك لمكالمة جماعيّة$/, "$1$2 invites you to a group call"],
  [/^🎙 (.*) بدأ دردشة صوتيّة — انضمّ متى شئت$/, "🎙 $1 started a voice chat — join anytime"],
  [/^📅 (.*) دعاك إلى غرفة سوا$/, "📅 $1 invited you to a Sawa room"], [/^📅 (.*) دعاك لمكالمة$/, "📅 $1 invited you to a call"],
  [/^مكالمة فيديو(.*) — افتح «المكالمات المجدولة»$/, "Video call$1 — open Scheduled calls"], [/^مكالمة صوتيّة(.*) — افتح «المكالمات المجدولة»$/, "Voice call$1 — open Scheduled calls"],
  [/^⏰ تذكير: غرفة سوا(.*)$/, "⏰ Reminder: Sawa room$1"], [/^⏰ تذكير: مكالمة فيديو(.*)$/, "⏰ Reminder: video call$1"], [/^⏰ تذكير: مكالمة صوتيّة(.*)$/, "⏰ Reminder: voice call$1"],
  [/^تبدأ بعد (.*) — اضغط للدخول$/, (m, x) => "Starts in " + enMins(x) + " — tap to join"],
  [/^تبدأ بعد (.*) — من «المكالمات المجدولة» اضغط «ابدأ الآن»$/, (m, x) => "Starts in " + enMins(x) + " — tap Start now in Scheduled calls"],
  [/^حان الموعد — اضغط للدخول$/, "It's time — tap to join"], [/^حان الموعد — افتح «المكالمات المجدولة» وانضمّ$/, "It's time — open Scheduled calls and join"],
  [/^طلب تواصل في سوا$/, "Contact request on Sawa"], [/^(.*) يريد التواصل معك$/, "$1 wants to connect with you"],
  [/^قبل طلب التواصل — يمكنكما المراسلة الآن ✓$/, "Accepted your request — you can chat now ✓"],
  [/^تأكيد رقم في سوا$/, "Confirm a number on Sawa"], [/^(.*) يطلب منك تأكيد أنّ رقمه (.*)$/, "$1 asks you to confirm their number is $2"],
  [/^تأكّد رقمك ✓$/, "Your number is confirmed ✓"], [/^أكّد اثنان من معارفك رقمك (.*) — صار بإمكان معارفك إيجادك به$/, "Two contacts confirmed your number $1 — people you know can now find you by it"],
  [/^طلب ربط في شجرة العائلة$/, "Family tree link request"], [/^(.*) يقول إنك «(.*)» في شجرة «(.*)» — هل هذا أنت؟$/, "$1 says you're “$2” in the “$3” tree — is this you?"],
  [/^تمّ الربط ✓$/, "Linked ✓"], [/^(.*) أكّد أنّه «(.*)» في «(.*)»$/, "$1 confirmed they're “$2” in “$3”"],
  [/^لحظة جديدة(.*)$/, "New moment$1"], [/^أوّل لحظة منذ فترة طويلة(.*)$/, "First moment in a long time$1"],   // C153
  [/^علّق على لحظتك: (.*)$/, "Commented on your moment: $1"], [/^ردّ على تعليقك: (.*)$/, "Replied to your comment: $1"],   // C152
  [/^أشار إليك في لحظة: (.*)$/, "Mentioned you in a moment: $1"], [/^أشار إليك في تعليق: (.*)$/, "Mentioned you in a comment: $1"],
  [/^علّق على لحظتك$/, "Commented on your moment"], [/^ردّ على تعليقك$/, "Replied to your comment"], [/^أشار إليك في لحظة$/, "Mentioned you in a moment"], [/^أشار إليك في تعليق$/, "Mentioned you in a comment"],
  [/^(\S+) أعجبته لحظتك · (.*)$/, "$1 liked your moment · $2"], [/^(\S+) تفاعل مع لحظتك · (.*)$/, "$1 reacted to your moment · $2"],
  [/^(.*) أعجبته لحظتك$/, "$1 liked your moment"], [/^(.*) علّق على لحظتك$/, "$1 commented on your moment"],
  [/^قريبك/, "Your relative"], [/^مستخدم سوا/, "A Sawa user"], [/^غرفة سوا$/, "Sawa room"], [/^سوا$/, "Sawa"],
];
function enMins(x) { const n = x === "دقيقة" ? 1 : x === "دقيقتين" ? 2 : parseInt(x, 10) || 0; return n === 1 ? "1 minute" : n + " minutes"; }
function enText(v) {
  let s = String(v == null ? "" : v);
  for (const [re, to] of EN_RULES) { if (re.test(s)) { s = s.replace(re, to); } }
  return s;
}
function langData(d, en) {
  if (!en || !d) return d;
  const o = Object.assign({}, d);
  if (o.title != null) o.title = enText(o.title);
  if (o.body != null && o.t !== "msg") o.body = enText(o.body);
  else if (o.body != null) o.body = enMsgBody(o.body);
  o.lang = "en";
  return o;
}
// نصّ الرسالة نفسه لا يُترجم — فقط وصف المرفقات («📷 صورة»…) ورسالة التشفير
function enMsgBody(b) { return enText(b); }
function apnsOf(d) {
  const call = d.t === "call", ttl = call ? 45 : d.t === "test" ? 120 : 86400;
  const alert = { title: String(d.title || "سوا").slice(0, 120), body: String(d.body || "").slice(0, 400) };
  const aps = { alert, sound: "default", "thread-id": String(d.cid || d.t || "sawa").slice(0, 60) };
  if (call) aps["interruption-level"] = "time-sensitive";
  const headers = { "apns-priority": "10", "apns-push-type": "alert", "apns-expiration": String(Math.floor(Date.now() / 1000) + ttl) };
  const cid = call ? "c" + (d.call || "") : d.t === "missed" ? "c" + (d.call || "") : "";
  if (cid) headers["apns-collapse-id"] = cid.slice(0, 64);
  return { headers, payload: { aps } };
}
async function fcmSend(token, devToken, data, lang) {
  if (lang === "en") data = langData(data, true);   // v68
  const res = await fetch("https://fcm.googleapis.com/v1/projects/" + PROJECT_ID + "/messages:send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token: devToken, data: data,
      // C72: تطبيق أندرويد الأصليّ — رسالة بيانات بأولويّة عالية توقظ الهاتف (للمتصفّح يُتجاهل هذا الجزء)
      android: { priority: "HIGH", ttl: data.t === "call" ? "45s" : data.t === "test" ? "120s" : "86400s" },
      webpush: { headers: { Urgency: data.t === "call" || data.t === "test" ? "high" : "normal", TTL: data.t === "call" ? "45" : data.t === "test" ? "120" : "86400" } },
      apns: apnsOf(data) } }) });
  if (res.ok) return "ok";
  const txt = await res.text();
  // v56: INVALID_ARGUMENT لا يعني رمزاً ميّتاً إلّا إن كان عن الرمز نفسه (كانت أخطاء الحمولة تحذف أجهزة سليمة)
  if (/UNREGISTERED|registration-token-not-registered|NOT_FOUND/.test(txt) || (/INVALID_ARGUMENT/.test(txt) && /registration token/i.test(txt))) return "gone";
  console.log("fcm err:", txt.slice(0, 300)); stat("push:err");
  return "err";
}
// C60: أجهزة المستخدم مرتّبةً بالأحدث تسجيلاً (ts) — حتى لا يحجب رمزٌ ميّت قديم رمزاً حيّاً جديداً
const DEV_MAX = 5, DEV_TTL = 60 * 86400000;
// C180: الخطّة المدفوعة في Cloudflare Workers (١٠٠٠ طلبٍ فرعيّ لكلّ تشغيل بدل ٥٠) ⇒ حدودٌ أوسع. WORKERS_FREE=1 يعيد حدود المجّانيّة.
function LIM(env) {
  const free = String((env && env.WORKERS_FREE) || (PUSH_ENV && PUSH_ENV.WORKERS_FREE) || "") === "1";
  return free ? { free, push: 12, ring: 10, contacts: 4, mom: 10, task: 12, rem: 1, remBatch: 12, purge: 40, media: 10, story: 2, q: 10, dis: 5 }
              : { free, push: 200, ring: 60, contacts: 7, mom: 60, task: 100, rem: 10, remBatch: 100, purge: 400, media: 60, story: 10, q: 60, dis: 40 };
}
function devTs(d) { return Number(((d.fields || {}).ts || {}).integerValue || 0); }
async function devsOf(token, uid) {
  const devs = await fsList(token, "accounts/" + uid + "/devices");
  devs.sort((a, b) => devTs(b) - devTs(a));
  return devs;
}
// يُرسل لأجهزة مستخدمين (حتّى ١٢ مستخدماً لكلّ حدث — حدّ ٥٠ طلباً فرعيّاً)، ويحذف الرموز الميّتة
/* ---------- C151: إشعارات VoIP للآيفون (شاشة المكالمة الواردة من النظام — CallKit) ----------
   FCM لا يرسل VoIP ⇒ الخادم يرسل مباشرةً إلى Apple بمفتاح APNs (‎.p8‎) — سرّ الـWorker ‏APNS_P8 (محتوى الملفّ كاملاً)،
   ومعه APNS_KEY_ID و APNS_TEAM_ID (أو القيم الافتراضيّة أدناه). الموضوع: com.sawaaap.app.voip · البيئة من تسجيل الجهاز (production/development).
   ينجح ⇒ لا يُرسَل إشعار FCM لذلك الجهاز (لا تكرار) · يفشل ⇒ يُكمَل بإشعار FCM كما كان. */
let PUSH_ENV = null;
const APNS_TOPIC = "com.sawaaap.app.voip";
let apnsJwt = { t: 0, v: null, key: null };
function b64url(buf) { let s = ""; const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function apnsToken(env) {
  if (!env || !env.APNS_P8) return null;
  if (apnsJwt.v && Date.now() - apnsJwt.t < 40 * 60000) return apnsJwt.v;
  if (!apnsJwt.key) {
    const pem = String(env.APNS_P8).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    apnsJwt.key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const kid = env.APNS_KEY_ID || "54D2KDJT6K", iss = env.APNS_TEAM_ID || "QD9SY2YYKY", now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "ES256", kid }), body = enc({ iss, iat: now });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, apnsJwt.key, new TextEncoder().encode(head + "." + body));
  apnsJwt.v = head + "." + body + "." + b64url(sig); apnsJwt.t = Date.now();
  return apnsJwt.v;
}
// ⇒ "ok" | "gone" (الرمز ميّت) | نصّ الخطأ
async function apnsVoip(env, devToken, envName, payload) {
  const jwt = await apnsToken(env);
  if (!jwt) return "no-key";
  const host = envName === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  try {
    const r = await fetch(host + "/3/device/" + devToken, { method: "POST", headers: {
      authorization: "bearer " + jwt, "apns-topic": APNS_TOPIC, "apns-push-type": "voip", "apns-priority": "10", "apns-expiration": "0", "content-type": "application/json" },
      body: JSON.stringify(payload) });
    if (r.status === 200) { stat("voip"); return "ok"; }
    const t = await r.text().catch(() => "");
    if (r.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(t)) return "gone";
    if (r.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(t)) apnsJwt = { t: 0, v: null, key: null };
    return "apns " + r.status + " " + t.slice(0, 160);
  } catch (e) { return "fetch " + String(e && e.message || e).slice(0, 160); }
}
const voipOk = new Map();   // callId|device ⇒ أُرسل VoIP بنجاح (تكرار الرنين لا يُرسل FCM لهذا الجهاز)
// إن كان الجهاز آيفون برمز VoIP: «call» ⇒ VoIP مرّةً واحدة · «missed» ⇒ VoIP إلغاء (تُغلق شاشة النظام) ثمّ FCM «فائتة» كالعادة. يُرجع true إن أغنى عن FCM.
async function voipFor(dev, du) {
  const vt = fstr(dev, "voip"); if (!vt || !PUSH_ENV || !PUSH_ENV.APNS_P8 || !du) return false;
  const key = String(du.call || "") + "|" + dev.name;
  if (du.t === "call" && du.call) {
    if (voipOk.has(key)) return true;
    const r = await apnsVoip(PUSH_ENV, vt, fstr(dev, "voipEnv") || "production", { call: du.call, title: du.title || "Sawa", type: du.type || "audio", to: du.to || "", rk: du.rk || "", uf: du.uf || "", gid: du.gid || "", ts: du.ts || "" });
    if (r === "ok") { voipOk.set(key, Date.now()); if (voipOk.size > 500) { const old = Date.now() - 600000; for (const [k, v] of voipOk) if (v < old) voipOk.delete(k); } return true; }
    if (r !== "no-key") console.log("voip:", r);
    return false;
  }
  if (du.t === "missed" && du.call) { await apnsVoip(PUSH_ENV, vt, fstr(dev, "voipEnv") || "production", { call: du.call, cancel: "1", title: du.title || "" }); voipOk.delete(key); }
  return false;
}
// المدير: اختبار VoIP على أجهزتي (يُظهر ردّ Apple كما هو — يكشف المفتاح أو البيئة أو اتّصال الخادم)
async function opVoipTest(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const devs = await devsOf(token, uid), out = [];
  for (const d of devs) {
    const vt = fstr(d, "voip"); if (!vt) continue;
    const r = await apnsVoip(env, vt, fstr(d, "voipEnv") || "production", { call: "test_" + Date.now().toString(36), title: "سوا — اختبار المكالمة", type: "audio", cancelAfter: "8" });
    out.push({ env: fstr(d, "voipEnv") || "production", result: r });
  }
  return { admin: true, key: !!env.APNS_P8, devices: out };
}
async function pushTo(token, uids, data) {
  let sent = 0;
  const L = LIM(PUSH_ENV), list = [...new Set(uids)].slice(0, L.push);
  // C180: بالتوازي (٨ مستلمين معاً) — المجموعات الكبيرة كانت تصل لأوّل ١٢ فقط وبالتتابع
  const one = async (u) => {
    const devs = await devsOf(token, u);
    const du = typeof data === "function" ? await data(u) : data;   // v65: بيانات خاصّة بكلّ مستلم (توقيع الإقرار)
    for (const d of devs.slice(0, DEV_MAX)) {
      if (await voipFor(d, du).catch(() => false)) { sent++; continue; }   // C151
      // C164: الجهاز أطفأ صور المرسلين ⇒ بلا توقيع الصورة (يبقى شعار سوا)
      const dd = du && du.ak && fbool(d, "noav") ? Object.assign({}, du, { ak: undefined }) : du;
      if (dd !== du) delete dd.ak;
      const r = await fcmSend(token, fstr(d, "token"), dd, fstr(d, "lang"));
      if (r === "ok") { sent++; stat("push"); }
      else if (r === "gone") await fsCommit(token, [{ delete: d.name }]).catch(() => {});
    }
  };
  for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(u => one(u).catch(e => console.log("push to:", e && e.message))));
  return sent;
}
// v56: «from» مفتاحٌ محجوز في FCM (ومعه message_type و google.*/gcm.*) — وجوده يجعل FCM يرفض الرسالة كلّها (INVALID_ARGUMENT):
//      كلّ مكالمةٍ ورسالةٍ وطلبٍ كان يُرفض بصمت (الإشعار التجريبيّ وحده بلا from فيصل)، بل كان الرفض يُعدّ «رمزاً ميّتاً» فيُحذف جهاز المستلم.
//      المرسِل صار «uf»، والواجهات تقرأ uf || from.
function strData(o) { const out = {}; for (const k in o) if (o[k] != null) { const kk = k === "from" ? "uf" : k; if (kk === "message_type" || kk === "notification" || /^(google|gcm)/i.test(kk)) continue; out[kk] = String(o[k]).slice(0, 900); } return out; }
async function notifyChat(token, c, cid, uid, msg) {
  const members = fsArr(c, "members"), muted = fsArr(c, "mutedBy"), type = fstr(c, "type");
  const names = fsToJs((c.fields || {}).names || { nullValue: null }) || {};
  const senderName = names[uid] || "سوا";
  const mentions = msg.mentions || [];
  // المُشار إليهم أوّلاً (ويصلهم ولو كتموا المجموعة)، ثمّ الباقون غير المكتومين
  const tAssigned = msg.type === "tasks" && !msg.enc ? ((msg.extra && msg.extra.tasks) || []).map(t => t.assigneeId).filter(Boolean) : [];   // C173
  const targets = members.filter(u => u !== uid && tAssigned.indexOf(u) < 0 && (mentions.indexOf(u) >= 0 || muted.indexOf(u) < 0))
    .sort((a, b) => (mentions.indexOf(b) >= 0) - (mentions.indexOf(a) >= 0));
  if (!targets.length || type === "saved") return 0;
  const group = type === "group" || type === "family";
  const body = msg.enc ? "🔒 رسالة مشفّرة" : msg.type === "text" || msg.type === "sticker" ? (msg.text || "") : ({ image: "📷 صورة", video: "🎥 فيديو", voice: "🎤 رسالة صوتيّة", file: "📎 ملفّ", poll: "📊 استطلاع", bill: "🧾 فاتورة", fund: "💝 تبرّعات", tasks: "✅ " + ((msg.extra && msg.extra.title) || "مهامّ"), contact: "👤 جهة اتّصال", location: "📍 موقع" }[msg.type] || "رسالة");
  const base = { t: "msg", cid, from: uid, ak: notifyChat.env ? await ackSig(notifyChat.env, "av|" + uid) : undefined, mid: msg.id, title: group ? (fstr(c, "name") || "سوا") : senderName, body: group ? senderName + ": " + body : body, ts: msg.ts };
  let sent = 0;
  const ment = targets.filter(u => mentions.indexOf(u) >= 0), rest = targets.filter(u => mentions.indexOf(u) < 0);
  const env0 = notifyChat.env;
  const signed = (o) => env0 ? async (u) => strData(Object.assign({}, o, { to: u, dk: await ackSig(env0, "d|" + cid + "|" + u + "|" + msg.ts) })) : strData(o);
  if (ment.length) sent += await pushTo(token, ment, signed(Object.assign({}, base, { mention: "1", title: senderName + " أشار إليك" + (group ? " في " + (fstr(c, "name") || "") : "") })));
  if (rest.length) sent += await pushTo(token, rest.slice(0, Math.max(0, LIM(env0).push - ment.length)), signed(base));   // C180
  return sent;
}
// الكتم يُنسخ إلى المحادثة نفسها (mutedBy) فلا يقرأ الإرسال إعدادات كلّ عضو
async function syncMutedBy(token, uid, before, after) {
  const b = new Set(before || []), a = new Set(after || []);
  const changes = [];
  a.forEach(cid => { if (!b.has(cid)) changes.push([cid, "appendMissingElements"]); });
  b.forEach(cid => { if (!a.has(cid)) changes.push([cid, "removeAllFromArray"]); });
  for (const [cid, op] of changes.slice(0, 20)) {
    if (!/^(dm_|sdm_|sv_|fam_|grp_)/.test(cid) || !segOk(cid)) continue;
    if (op === "appendMissingElements") {   // v61: العضو وحده يضيف نفسه إلى mutedBy
      const cd = await fsGet(token, "chats/" + cid).catch(() => null);
      if (!cd || fsArr(cd, "members").indexOf(uid) < 0) continue;
    }
    await fsCommit(token, [{ transform: { document: DOC_ROOT + "/chats/" + cid, fieldTransforms: [{ fieldPath: "mutedBy", [op]: { values: [{ stringValue: uid }] } }] },
      currentDocument: { exists: true } }]).catch(() => {});
  }
}

/* ---------- 30) المكالمات الجماعيّة (C7) ----------
   الخادم وحده ينشئ gcalls/{gid} ويحدّد من يُسمح له (allow)؛ الأجهزة تنضمّ وتتبادل الإشارات مباشرةً (قواعد RTDB).
   gcur/{cid} يشير للمكالمة الجارية في محادثةٍ جماعيّة (شريط «انضمام»). */
/* ---------- 45) الغرف الكبيرة: وسيطٌ إلى Cloudflare Realtime SFU (C45) ----------
   السرّان: CF_SFU_APP_ID و CF_SFU_APP_TOKEN (Cloudflare ← Realtime ← SFU ← Create application). المفتاح لا يغادر الخادم.
   الحراسة: الغرفة كبيرة (rooms/$code/meta/big) وأنا عضوٌ فيها · الجلسة جلستي (sfuown/$sid) · المسار المسحوب لجلسة عضوٍ في الغرفة نفسها. */
const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps/";
const SFU_OWN = new Map();
function sfuOn(env) { return !!(env.CF_SFU_APP_ID && env.CF_SFU_APP_TOKEN); }
async function sfuApi(env, method, path, body) {
  const res = await fetch(SFU_BASE + encodeURIComponent(String(env.CF_SFU_APP_ID).trim()) + path, {
    method, headers: { Authorization: "Bearer " + String(env.CF_SFU_APP_TOKEN).trim(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errorCode) throw new Error("sfu " + res.status + ": " + (j.errorDescription || j.errorCode || "error"));
  return j;
}
const SFU_ROOM_RE = /^[A-HJ-NP-Z2-9]{8}$/, SFU_SID_RE = /^[A-Za-z0-9_-]{8,80}$/, SFU_TRK_RE = /^[A-Za-z0-9_-]{1,40}$/, SFU_MID_RE = /^[A-Za-z0-9_-]{1,16}$/;
async function sfuOwn(token, sid) {
  const c = SFU_OWN.get(sid); if (c) return c;
  const v = await rtdbGet(token, "sfuown/" + sid).catch(() => null);
  if (v && v.u) { SFU_OWN.set(sid, v); if (SFU_OWN.size > 5000) SFU_OWN.clear(); }
  return v;
}
async function sfuGuard(uid, payload, env, needSid) {
  if (!sfuOn(env)) throw new Error("not_configured");
  if (!codeRate(uid, "sfu", 900)) throw new Error("rate_limited");
  const room = String((payload && payload.room) || "");
  if (!SFU_ROOM_RE.test(room)) throw new Error("bad_room");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  let sid = null;
  if (needSid) {
    sid = String(payload.sid || "");
    if (!SFU_SID_RE.test(sid)) throw new Error("bad_sid");
    const o = await sfuOwn(token, sid);
    if (!o || o.u !== uid || o.room !== room) throw new Error("not_yours");
  }
  return { token, room, sid };
}
async function opSfuCfg(uid, payload, env) { return { enabled: sfuOn(env), max: 30 }; }
async function opSfuNew(uid, payload, env) {
  const g = await sfuGuard(uid, payload, env, false);
  const [big, mine] = await Promise.all([rtdbGet(g.token, "rooms/" + g.room + "/meta/big"), rtdbGet(g.token, "rooms/" + g.room + "/members/" + uid + "/sess")]);
  if (big !== true) throw new Error("not_big");
  if (!mine) throw new Error("not_member");
  const j = await sfuApi(env, "POST", "/sessions/new");
  if (!j.sessionId || !SFU_SID_RE.test(j.sessionId)) throw new Error("sfu: no session");
  const own = { u: uid, room: g.room, ts: Date.now() };
  await rtdbPatch(g.token, { ["sfuown/" + j.sessionId]: own });
  SFU_OWN.set(j.sessionId, own);
  stat("sfu:new");
  return { sessionId: j.sessionId };
}
async function opSfuPush(uid, payload, env) {
  const g = await sfuGuard(uid, payload, env, true);
  const sdp = String(payload.sdp || ""); if (!sdp || sdp.length > 60000) throw new Error("bad_sdp");
  const tracks = (payload.tracks || []).slice(0, 2).map(t => ({ location: "local", mid: String(t.mid), trackName: String(t.trackName) }));
  if (!tracks.length || tracks.some(t => !SFU_MID_RE.test(t.mid) || !SFU_TRK_RE.test(t.trackName))) throw new Error("bad_tracks");
  const j = await sfuApi(env, "POST", "/sessions/" + g.sid + "/tracks/new", { sessionDescription: { type: "offer", sdp }, tracks });
  return { sdp: j.sessionDescription && j.sessionDescription.sdp, tracks: (j.tracks || []).map(t => ({ mid: t.mid, trackName: t.trackName, error: t.errorCode || null })) };
}
async function opSfuPull(uid, payload, env) {
  const g = await sfuGuard(uid, payload, env, true);
  const want = (payload.tracks || []).slice(0, 40).map(t => ({ sessionId: String(t.sessionId), trackName: String(t.trackName), sc: t.sc === true, rid: t.rid === "h" ? "h" : "f" }));
  if (!want.length || want.some(t => !SFU_SID_RE.test(t.sessionId) || !SFU_TRK_RE.test(t.trackName) || t.sessionId === g.sid)) throw new Error("bad_tracks");
  // كلّ جلسةٍ مسحوبة لعضوٍ في الغرفة نفسها، وصاحبها ما زال عضواً
  const members = await rtdbGet(g.token, "rooms/" + g.room + "/members").catch(() => null) || {};
  if (!members[uid]) throw new Error("not_member");
  const ok = [], rejected = [];
  for (const sid of Array.from(new Set(want.map(t => t.sessionId)))) {
    const o = await sfuOwn(g.token, sid);
    if (o && o.room === g.room && members[o.u]) ok.push(sid); else rejected.push(sid);
  }
  // C179: Simulcast — الناشر يرسل طبقتين (f كاملة · h نصف الدقّة) والخادم يختار لكلّ مشاهدٍ ما تحتمله شبكته (asciibetical: f ثمّ h)
  const tracks = want.filter(t => ok.indexOf(t.sessionId) >= 0).map(t => Object.assign({ location: "remote", sessionId: t.sessionId, trackName: t.trackName },
    t.sc ? { simulcast: { preferredRid: t.rid, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" } } : {}));
  const out = want.filter(t => ok.indexOf(t.sessionId) < 0).map(t => ({ sessionId: t.sessionId, trackName: t.trackName, error: "not_in_room" }));
  if (!tracks.length) return { tracks: out, renegotiate: false };
  const j = await sfuApi(env, "POST", "/sessions/" + g.sid + "/tracks/new", { tracks });
  stat("sfu:pull");
  return { sdp: j.sessionDescription && j.sessionDescription.sdp, renegotiate: !!j.requiresImmediateRenegotiation,
    tracks: out.concat((j.tracks || []).map(t => ({ mid: t.mid || null, trackName: t.trackName, sessionId: t.sessionId, error: t.errorCode || null }))) };
}
async function opSfuReneg(uid, payload, env) {
  const g = await sfuGuard(uid, payload, env, true);
  const sdp = String(payload.sdp || ""); if (!sdp || sdp.length > 60000) throw new Error("bad_sdp");
  await sfuApi(env, "PUT", "/sessions/" + g.sid + "/renegotiate", { sessionDescription: { type: "answer", sdp } });
  return { done: true };
}
async function opSfuClose(uid, payload, env) {
  const g = await sfuGuard(uid, payload, env, true);
  const mids = (payload.mids || []).slice(0, 40).map(String).filter(m => SFU_MID_RE.test(m));
  if (!mids.length) return { done: true };
  await sfuApi(env, "PUT", "/sessions/" + g.sid + "/tracks/close", { tracks: mids.map(mid => ({ mid })), force: true });
  return { done: true, renegotiate: false };
}
async function rtdbGet(token, path, q) {
  const res = await fetch(RTDB_URL + "/" + path + ".json?access_token=" + encodeURIComponent(token) + (q || ""));
  if (!res.ok) throw new Error("rtdb get: " + res.status);
  return res.json();
}
function gcNewId() { return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
async function blockedBy(token, target, uid) {
  const pr = await fsGet(token, "accounts/" + target + "/chatprefs/main");
  const blocked = pr && fstr(pr, "data") ? (JSON.parse(fstr(pr, "data")).blocked || []) : [];
  return blocked.indexOf(uid) >= 0;
}
// v33: أيّهم حظرني؟ (blk/{هو}/{أنا} في RTDB — يكتبها الـWorker عند حفظ قائمة الحظر)
async function blockedSet(token, targets, uid) {
  const out = new Set();
  await Promise.all(targets.map(u => rtdbGet(token, "blk/" + u + "/" + uid).then(v => { if (v === true) out.add(u); }).catch(() => {})));
  return out;
}
async function opGcallStart(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  payload = payload || {};
  let type = payload.type === "video" ? "video" : "audio";
  const me = memberIdFields(claims).name.stringValue || "سوا";
  let allow = [uid], ring = [], cid = null, title = "", gid = null, approval = false, by = uid, muted = [], isSched = false;
  if (payload.cid) {
    cid = String(payload.cid);
    const c = await requireChatMember(token, cid, uid);
    const t = fstr(c, "type");
    if (t !== "group" && t !== "family") throw new Error("not a group chat");
    title = fstr(c, "name") || "مجموعة";
    allow = fsArr(c, "members"); muted = fsArr(c, "mutedBy");
    // مكالمةٌ جارية في هذه المحادثة؟ ⇒ انضمّ إليها (ويُضاف المتأخّر إلى المسموح لهم)
    const curp = await rtdbGet(token, "gcur/" + cid);
    if (curp && curp.gid && segOk(String(curp.gid))) {
      const live = await rtdbGet(token, "gcalls/" + curp.gid);
      if (live && live.members && Object.keys(live.members).length) {
        if (!(live.allow && live.allow[uid])) await rtdbPatch(token, { ["gcalls/" + curp.gid + "/allow/" + uid]: true });
        return { gid: curp.gid, joined: true, type: live.type, title: live.title || title, by: live.by, approval: !!live.approval, cid, vc: !!live.vc };
      }
      await rtdbPatch(token, { ["gcalls/" + curp.gid]: null });   // مؤشّرٌ لمكالمةٍ انتهت
    }
    ring = payload.vc ? [] : allow.filter(u => u !== uid);   // v37: «دردشة صوتيّة» = غرفةٌ مفتوحة بلا رنين
  } else if (payload.sched) {
    const sid = String(payload.sched);
    if (!/^[a-z0-9]{6,32}$/.test(sid)) throw new Error("bad id: sched");
    const s = await fsGet(token, "scheds/" + sid);
    if (!s) throw new Error("schedule not found");
    const users = fsArr(s, "users");
    if (users.indexOf(uid) < 0) throw new Error("not invited");
    gid = "s" + sid; isSched = true;
    const live = await rtdbGet(token, "gcalls/" + gid);
    if (live && live.members && Object.keys(live.members).length)
      return { gid, joined: true, type: live.type, title: live.title, by: live.by, approval: !!live.approval, cid: live.cid || null };
    allow = users; by = fstr(s, "by") || uid; approval = fbool(s, "approval");
    title = fstr(s, "title") || fstr(s, "toName") || "مكالمة مجدولة";
    type = fstr(s, "type") === "video" ? "video" : "audio";
    cid = fstr(s, "cid") || null;
    ring = users.filter(u => u !== uid);
  } else if (Array.isArray(payload.to)) {
    const to = [...new Set(payload.to.map(String))].filter(u => u !== uid).slice(0, 7);
    if (!to.length || to.some(u => !segOk(u))) throw new Error("bad call");
    for (const u of to) if (!(await sharesContact(token, uid, u))) throw new Error("not a contact");
    const quiet = Array.isArray(payload.quiet) ? payload.quiet.map(String) : [];
    allow = [uid].concat(to);
    ring = to.filter(u => quiet.indexOf(u) < 0);
    // الإشعار لا يصل لمن حظرك (الرنين داخل التطبيق يُسقطه جهازه أيضاً) — يُفحص لمن سيصلهم إشعار فقط
    const pushable = [];
    for (const u of ring.slice(0, LIM(env).contacts)) if (!(await blockedBy(token, u, uid))) pushable.push(u);
    payload.__push = pushable;
    title = typeof payload.title === "string" ? payload.title.slice(0, 80) : "";
  } else throw new Error("bad call");
  if (allow.indexOf(uid) < 0) allow.unshift(uid);
  allow = allow.slice(0, 64);
  gid = gid || gcNewId();
  const now = Date.now();
  const vc = !!(payload.vc && cid && !isSched);
  if (vc) type = "audio";
  const node = { by, type, title: String(title || "").slice(0, 80), ts: now, approval: !!approval, allow: Object.fromEntries(allow.map(u => [u, true])) };
  if (cid) node.cid = cid;
  if (vc) node.vc = true;
  const upd = { ["gcalls/" + gid]: node };
  if (cid && !isSched) upd["gcur/" + cid] = vc ? { gid, type, by: uid, ts: now, vc: true } : { gid, type, by: uid, ts: now };
  for (const u of ring.slice(0, 63)) upd["inbox/" + u + "/" + gid] = { from: uid, fromName: me, type, ts: now, gid, title: node.title };
  await rtdbPatch(token, upd);
  if (vc) {   // v37: لا رنين — رسالة نظامٍ في المحادثة وإشعارٌ عاديّ (لغير الكاتمين) يفتح المحادثة وفيها شريط «انضمام»
    try { await sysMsg(token, cid, uid, "vc_on", {}); } catch (e) {}
    const soft = allow.filter(u => u !== uid && muted.indexOf(u) < 0).slice(0, LIM(env).ring);
    if (soft.length) {
      const job = pushTo(token, soft, strData({ t: "msg", cid, from: uid, mid: "vc" + gid, title: node.title || "سوا", body: "🎙 " + me + " بدأ دردشة صوتيّة — انضمّ متى شئت", ts: now }));
      if (ctx && ctx.waitUntil) ctx.waitUntil(job.catch(() => {})); else await job.catch(() => {});
    }
    return { gid, joined: false, type, title: node.title, by, approval: false, cid, vc: true };
  }
  // إشعار رنين لمن لم يكتموا (≤ ١٠ — حدّ الطلبات الفرعيّة)
  // ≤ ١٠ للمجموعة، ≤ ٤ لجهات الاتّصال (حدّ ٥٠ طلباً فرعيّاً لكلّ طلب في خطّة Workers المجّانيّة)
  const targets = payload.__push || ring.filter(u => muted.indexOf(u) < 0).slice(0, LIM(env).ring);   // C180
  if (targets.length) {
    const body = (type === "video" ? "📹 " : "📞 ") + (cid || isSched ? me + " بدأ مكالمة جماعيّة" : me + " يدعوك لمكالمة جماعيّة");
    const job = pushTo(token, targets, strData({ t: "call", call: gid, gid, from: uid, fromName: me, cid: cid || "", type, title: node.title || me, body, ts: now }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job.catch(() => {})); else await job;
  }
  return { gid, joined: false, type, title: node.title, by, approval: !!approval, cid };
}
// C178: المكالمة الجماعيّة تنتقل إلى خادم الوسائط (SFU) حين تكبر — العضو المنتخَب أنشأ غرفةً كبيرة (rooms/{code}/meta: host=هو · big · gcid)
//       والخادم يتحقّق ثمّ يكتب gcalls/{gid}/room فينتقل إليها الجميع (ومن يأتي لاحقاً)
async function opGcallRoom(uid, payload, env) {
  const gid = String((payload && payload.gid) || ""), code = String((payload && payload.code) || "");
  if (!segOk(gid) || !/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error("bad ref");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const [g, meta] = await Promise.all([rtdbGet(token, "gcalls/" + gid), rtdbGet(token, "rooms/" + code + "/meta")]);
  if (!g || !g.allow || g.allow[uid] !== true || !g.members || !g.members[uid]) throw new Error("not in this call");
  if (g.room) return { room: g.room };
  if (!meta || meta.host !== uid || meta.big !== true || meta.gcid !== gid) throw new Error("bad room");
  if (!sfuOn(env)) throw new Error("not_configured");
  await rtdbPatch(token, { ["gcalls/" + gid + "/room"]: code });
  stat("gcall:sfu");
  return { room: code };
}
async function opGcallAdd(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const gid = String((payload && payload.gid) || "");
  if (!/^[gs][a-z0-9]{6,40}$/.test(gid)) throw new Error("bad id: gid");
  const g = await rtdbGet(token, "gcalls/" + gid);
  if (!g || !g.allow || !g.allow[uid]) throw new Error("not in this call");
  const to = [...new Set(((payload && payload.to) || []).map(String))].filter(u => u !== uid).slice(0, LIM(env).contacts);
  if (!to.length || to.some(u => !segOk(u))) throw new Error("bad call");
  let chatMembers = [];
  if (g.cid) { const c = await chatDoc(token, g.cid); chatMembers = c ? fsArr(c, "members") : []; }
  for (const u of to) if (chatMembers.indexOf(u) < 0 && !(await sharesContact(token, uid, u))) throw new Error("not a contact");
  const me = memberIdFields(claims).name.stringValue || "سوا", now = Date.now();
  // v33: من حظرني لا تصله دعوتي (لا رنين ولا إشعار) — الردّ نفسه فلا يعرف المحظور
  const blk = await blockedSet(token, to, uid);
  const reach = to.filter(u => !blk.has(u));
  if (!reach.length) return { added: to.length };
  const upd = {};
  for (const u of reach) { upd["gcalls/" + gid + "/allow/" + u] = true; upd["inbox/" + u + "/" + gid] = { from: uid, fromName: me, type: g.type, ts: now, gid, title: g.title || "" }; }
  await rtdbPatch(token, upd);
  const job = pushTo(token, reach, strData({ t: "call", call: gid, gid, from: uid, fromName: me, cid: g.cid || "", type: g.type, title: g.title || me,
    body: (g.type === "video" ? "📹 " : "📞 ") + me + " يدعوك لمكالمة جماعيّة", ts: now }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job.catch(() => {})); else await job;
  return { added: to.length };
}

/* ---------- 31) المكالمات المجدولة (C7) ----------
   scheds/{id} = { by, byName, title, toName, type, at, end, remind, rq (وقت التذكير، 0 بعد الإرسال), approval, users[], cid, ts }
   Cron كلّ ٥ دقائق: تذكيرٌ بإشعار لكلّ المدعوّين حين يحين rq، وحذف المواعيد المنتهية منذ يومين. */
const REMINDS = [5, 15, 30, 60];
function schedOut(d) {
  const f = d.fields || {}, o = {};
  for (const k in f) o[k] = fsToJs(f[k]);
  o.id = d.name.split("/").pop();
  delete o.rq;
  return o;
}
async function opSchedSet(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = payload || {}, now = Date.now();
  let id = p.id ? String(p.id) : (now.toString(36) + Math.random().toString(36).slice(2, 8));
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new Error("bad id: sched");
  const old = p.id ? await fsGet(token, "scheds/" + id) : null;
  if (old && fstr(old, "by") !== uid) throw new Error("only the organizer can edit");
  const at = Math.round(Number(p.at)), end = Math.round(Number(p.end) || at + 1800000);
  if (!isFinite(at) || at < now - 3600000 || at > now + 400 * 86400000) throw new Error("bad time");
  const remind = REMINDS.indexOf(Number(p.remind)) >= 0 ? Number(p.remind) : 15;
  let users = [uid], cid = null, room = null;
  if (p.room) {   // C8: غرفة مجدولة (المدعوّون اختياريّون)
    room = String(p.room);
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(room)) throw new Error("bad id: room");
    const to = [...new Set((Array.isArray(p.to) ? p.to : []).map(String))].filter(u => u !== uid).slice(0, 7);
    if (to.some(u => !segOk(u))) throw new Error("bad call");
    for (const u of to) if (!(await sharesContact(token, uid, u))) throw new Error("not a contact");
    users = [uid].concat(to);
  } else if (p.cid) {
    cid = String(p.cid);
    const c = await requireChatMember(token, cid, uid);
    if (["group", "family"].indexOf(fstr(c, "type")) < 0) throw new Error("not a group chat");
    users = fsArr(c, "members").slice(0, 64);
  } else {
    const to = [...new Set((Array.isArray(p.to) ? p.to : []).map(String))].filter(u => u !== uid).slice(0, 7);
    if (!to.length || to.some(u => !segOk(u))) throw new Error("bad call");
    for (const u of to) if (!(await sharesContact(token, uid, u))) throw new Error("not a contact");
    users = [uid].concat(to);
  }
  if (users.indexOf(uid) < 0) users.unshift(uid);
  const me = memberIdFields(claims).name.stringValue || "سوا";
  const item = { by: uid, byName: me, title: String(p.title || "").slice(0, 120), toName: String(p.toName || "").slice(0, 80),
    type: p.type === "video" ? "video" : "audio", at, end: Math.max(end, at + 60000), remind, approval: !!p.approval, users, ts: now };
  if (cid) item.cid = cid;
  if (room) item.room = room;
  const rq = at - remind * 60000;
  const fields = {}; for (const k in item) fields[k] = toFsValue(item[k]);
  fields.rq = { integerValue: String(Math.max(rq, 1)) };
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/scheds/" + id, fields } }]);
  if (room) {   // بطاقة الغرفة جاهزة والمنظّم مضيفها — من يصل قبله يدخل، ولا يأخذ الاستضافة
    const meta = await rtdbGet(token, "rooms/" + room + "/meta").catch(() => null);
    if (!meta) await rtdbPatch(token, { ["rooms/" + room + "/meta"]: { host: uid, title: item.title || "غرفة سوا", ts: now, sched: at, sid: id, gc: at + 6 * 3600000, locked: false, lobby: !!item.approval, owner: uid } });
    else if (meta.host === uid) await rtdbPatch(token, { ["rooms/" + room + "/meta/sid"]: id, ["rooms/" + room + "/meta/sched"]: at, ["rooms/" + room + "/meta/gc"]: at + 6 * 3600000, ["rooms/" + room + "/meta/title"]: item.title || meta.title || "غرفة سوا" });
  }
  if (!old) {   // إشعار الدعوة للمدعوّين
    let others = users.filter(u => u !== uid).slice(0, 8);
    if (others.length) { const blk = await blockedSet(token, others, uid); others = others.filter(u => !blk.has(u)); }   // v33
    if (others.length) {
      const job = pushTo(token, others, strData({ t: "sched", sid: id, cid: cid || "", room: room || "", title: "📅 " + me + (room ? " دعاك إلى غرفة سوا" : " دعاك لمكالمة"),
        body: (item.type === "video" ? "مكالمة فيديو" : "مكالمة صوتيّة") + (item.title ? " · " + item.title : "") + " — افتح «المكالمات المجدولة»", ts: now }));
      if (ctx && ctx.waitUntil) ctx.waitUntil(job.catch(() => {})); else await job;
    }
  }
  return { item: Object.assign({ id }, item) };
}
// v54 (C84): من وصله رابط غرفةٍ مجدولة ⇒ تُضاف إلى «مواعيدي» عنده ويصله التذكير — الرابط نفسه هو الدعوة
async function opSchedJoin(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const room = String((payload && payload.room) || "").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(room)) throw new Error("bad id: room");
  const meta = await rtdbGet(token, "rooms/" + room + "/meta").catch(() => null);
  let doc = null;
  if (meta && meta.sid && /^[a-z0-9]{6,32}$/.test(String(meta.sid))) doc = await fsGet(token, "scheds/" + meta.sid);
  if (!doc) {   // غرفٌ جُدولت قبل v54 (بلا sid في بطاقتها)
    const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "scheds" }], where: { fieldFilter: { field: { fieldPath: "room" }, op: "EQUAL", value: { stringValue: room } } }, limit: 3 } }) });
    const data = await res.json().catch(() => []);
    const docs = (Array.isArray(data) ? data : []).filter(r => r.document).map(r => r.document).sort((a, b) => fsInt(b, "at") - fsInt(a, "at"));
    doc = docs[0] || null;
  }
  if (!doc || fstr(doc, "room") !== room) return { joined: false, reason: "not scheduled" };
  const at = fsInt(doc, "at"), end = fsInt(doc, "end") || at + 1800000;
  if (end < Date.now() - 3600000) return { joined: false, reason: "past" };
  const users = fsArr(doc, "users");
  if (users.indexOf(uid) < 0) {
    if (users.length >= 300) return { joined: false, reason: "full" };
    const blk = await blockedSet(token, [fstr(doc, "by")], uid).catch(() => new Set());
    if (blk.has(fstr(doc, "by"))) return { joined: false, reason: "blocked" };
    users.push(uid);
    await fsCommit(token, [{ update: { name: doc.name, fields: { users: toFsValue(users) } }, updateMask: { fieldPaths: ["users"] } }]);
  }
  return { joined: true, item: schedOut(Object.assign({}, doc, { fields: Object.assign({}, doc.fields, { users: toFsValue(users) }) })) };
}
async function opSchedList(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "scheds" }],
      where: { fieldFilter: { field: { fieldPath: "users" }, op: "ARRAY_CONTAINS", value: { stringValue: uid } } }, limit: 60 } }) });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore query: " + JSON.stringify(data));
  const now = Date.now();
  const items = (data || []).filter(r => r.document).map(r => schedOut(r.document)).filter(s => (s.end || s.at) > now - 86400000)
    .sort((a, b) => a.at - b.at);
  return { items };
}
async function opSchedDelete(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const id = String((payload && payload.id) || "");
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new Error("bad id: sched");
  const d = await fsGet(token, "scheds/" + id);
  if (!d) return { deleted: false };
  if (fstr(d, "by") === uid) {
    await fsCommit(token, [{ delete: d.name }]);
    return { deleted: true };
  }
  // مدعوّ: يزيل نفسه من القائمة فقط
  if (fsArr(d, "users").indexOf(uid) < 0) return { deleted: false };
  await fsCommit(token, [{ transform: { document: d.name, fieldTransforms: [{ fieldPath: "users", removeAllFromArray: { values: [{ stringValue: uid }] } }] } }]);
  return { left: true };
}
function minsAr(n) { return n === 1 ? "دقيقة" : n === 2 ? "دقيقتين" : n <= 10 ? n + " دقائق" : n + " دقيقة"; }
async function schedReminders(env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const now = Date.now();
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "scheds" }], where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "rq" }, op: "GREATER_THAN", value: { integerValue: "0" } } },
      { fieldFilter: { field: { fieldPath: "rq" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now + 150000) } } }] } }, limit: LIM(env).rem + 2 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let sent = 0;
  for (const d of rows.slice(0, LIM(env).rem)) {   // C180: ١٠ لكلّ تشغيل (المجّانيّة: واحد)
    // C84: الغرف المنشورة برابط قد يكثر مدعوّوها ⇒ دفعات من ١٢ في كلّ تشغيل (rqOff)
    const RB = LIM(env).remBatch, allU = fsArr(d, "users"), off = fsInt(d, "rqOff") || 0, batch = allU.slice(off, off + RB), more = off + RB < allU.length;
    // أوّلاً: علّمه مُرسَلاً (لا تكرار لو تعثّر الإرسال)
    await fsCommit(token, [{ update: { name: d.name, fields: more ? { rqOff: { integerValue: String(off + RB) } } : { rq: { integerValue: "0" }, rqOff: { integerValue: "0" } } }, updateMask: { fieldPaths: more ? ["rqOff"] : ["rq", "rqOff"] } }]);
    const at = fsInt(d, "at");
    if (at < now - 10 * 60000) continue;   // فات موعده
    const mins = Math.max(1, Math.round((at - now) / 60000));
    const title = fstr(d, "title") || fstr(d, "toName") || "", room = fstr(d, "room") || "";
    sent += await pushTo(token, batch, strData({ t: "sched", sid: d.name.split("/").pop(), cid: fstr(d, "cid") || "", room,
      title: "⏰ تذكير: " + (room ? "غرفة سوا" : fstr(d, "type") === "video" ? "مكالمة فيديو" : "مكالمة صوتيّة") + (title ? " · " + title : ""),
      body: room ? (at > now + 60000 ? "تبدأ بعد " + minsAr(mins) + " — اضغط للدخول" : "حان الموعد — اضغط للدخول")
                 : at > now + 60000 ? "تبدأ بعد " + minsAr(mins) + " — من «المكالمات المجدولة» اضغط «ابدأ الآن»" : "حان الموعد — افتح «المكالمات المجدولة» وانضمّ", ts: now }));
  }
  return { reminders: rows.length, sent };
}
async function cleanupCalls(env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const now = Date.now(), upd = {};
  let n = 0;
  // ١:١ قديمة (لم يحذفها المتّصل) · جماعيّة بلا أحد أو أقدم من ١٢ ساعة
  try {
    const calls = await rtdbGet(token, "calls", '&orderBy="ts"&endAt=' + (now - 3600000) + "&limitToFirst=30");
    for (const k in (calls || {})) { upd["calls/" + k] = null; n++; }
  } catch (e) {}
  try {
    const gs = await rtdbGet(token, "gcalls", '&orderBy="ts"&endAt=' + (now - 2 * 3600000) + "&limitToFirst=40");
    for (const k in (gs || {})) {
      const g = gs[k] || {};
      if (!g.members || now - (g.ts || 0) > 12 * 3600000) { upd["gcalls/" + k] = null; if (g.cid) upd["gcur/" + g.cid] = null; n++; }
    }
  } catch (e) {}
  // الغرف: فارغة وأقدم من ٣ ساعات (والمجدولة بعد مرور موعدها بـ٦ ساعات) أو منتهية
  try {
    // v35: المجدولة (موعدها بعيد) كانت تسدّ أوّل ٢٠ فيتوقّف التنظيف — الآن meta/gc (موعد جواز الحذف) + القديمة بنافذةٍ أوسع
    const rs = Object.assign({},
      await rtdbGet(token, "rooms", '&orderBy="meta/ts"&endAt=' + (now - 3 * 3600000) + "&limitToFirst=40").catch(() => ({})),
      await rtdbGet(token, "rooms", '&orderBy="meta/gc"&startAt=1&endAt=' + now + "&limitToFirst=20").catch(() => ({})));
    for (const k in (rs || {})) {
      const r = rs[k] || {}, m = r.meta || {};
      if ((!r.members && (!m.sched || m.sched < now - 6 * 3600000)) || m.ended) { upd["rooms/" + k] = null; n++; }
    }
  } catch (e) {}
  // المواعيد المنتهية منذ يومين
  try {
    const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "scheds" }], where: { fieldFilter: { field: { fieldPath: "end" }, op: "LESS_THAN", value: { integerValue: String(now - 2 * 86400000) } } }, limit: 10 } }) });
    const old = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
    if (old.length) await fsCommit(token, old.map(d => ({ delete: d.name })));
    n += old.length;
  } catch (e) {}
  if (Object.keys(upd).length) await rtdbPatch(token, upd);
  return { cleaned: n };
}

/* ---------- 32) الملفّ الشخصيّ: اسم «سوا» + رقم الهاتف (غير موثّق حتّى التحويل للمدفوع) ----------
   accounts/{uid}: { displayName, phone, phoneVerified:false }. يُنشر الاسم/الرقم إلى عضويّات العائلات ومحادثاتي وجهات اتّصالي
   (فيراه الآخرون فوراً)، والـWorker يقرأ الاسم المحفوظ بدل اسم Google في كلّ عمليّة (ذاكرة ١٠ دقائق). */
const PROFILE_CACHE = new Map();
async function profileOf(token, uid) {
  const c = PROFILE_CACHE.get(uid);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c;
  const d = await fsGet(token, "accounts/" + uid).catch(() => null);
  const v = { name: fstr(d, "displayName") || null, phone: fstr(d, "phone") || null, code: fstr(d, "code") || null, findable: accFindable(d), gname: fstr(d, "gname") || null,
    phoneVerified: fbool(d, "phoneVerified") === true, verifiedBy: fstr(d, "verifiedBy") || null, emailHash: fstr(d, "emailHash") || null, at: Date.now() };
  PROFILE_CACHE.set(uid, v);
  if (PROFILE_CACHE.size > 2000) PROFILE_CACHE.clear();
  return v;
}
function cleanPhone(x) {
  let s = String(x || "").replace(/[\s\-().]/g, "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (/^0\d{9}$/.test(s)) s = "+249" + s.slice(1);   // رقمٌ سودانيّ محلّيّ 09…/01…
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
async function opProfileGet(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = await profileOf(token, uid);
  const cd = p.code ? { code: p.code, findable: p.findable } : await ensureCode(token, uid, claims, false).catch(() => ({ code: null, findable: true }));
  const emailVerified = await ensureEmailIndex(token, uid, claims, p).catch(() => false);
  return { profile: { name: p.name, phone: p.phone, phoneVerified: !!p.phoneVerified, verifiedBy: p.phoneVerified ? (p.verifiedBy || "whatsapp") : null, emailVerified, email: emailVerified ? claims.email : null, googleName: claims.name || null, code: cd.code, findable: cd.findable,
    anon: !!(claims.firebase && claims.firebase.sign_in_provider === "anonymous") }, verify: verifyConfig(env) };
}
/* ---------- 43) التحقّق من الهويّة (C43) ----------
   • البريد: Google يوثّقه، وحساب البريد يوثَّق برابط Firebase (email_verified في الرمز). نفهرسه emails/{sha256(البريد)} = { uid } ليُعثر عليك به.
   • الهاتف: بلا SMS (Blaze غير متاح). المستخدم يرسل «SAWA-XXXXXX» إلى رقم سوا على واتساب (محادثة يبدؤها المستخدم ⇒ مجّانيّة)،
     وMeta تستدعي /wa/webhook فنقرأ رقم المرسل الموثَّق عند واتساب ونطابق الرمز. الرقم الذي أرسل الرمز هو الذي يُوثَّق (ويحلّ محلّ المكتوب).
     الأسرار: WA_NUMBER (رقم سوا بصيغة أرقامٍ دوليّة بلا +) · WA_VERIFY_TOKEN (كلمة تحقّق الـwebhook) · WA_APP_SECRET (توقيع Meta)
     · اختياريّان للردّ: WA_TOKEN و WA_PHONE_ID. */
function verifyConfig(env) {
  const wa = !!(env.WA_NUMBER && env.WA_VERIFY_TOKEN && env.WA_APP_SECRET);
  return { whatsapp: wa, waNumber: wa ? String(env.WA_NUMBER).replace(/\D/g, "") : null };
}
async function sha256Hex(t) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return Array.from(h).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function ensureEmailIndex(token, uid, claims, p) {
  const em = claims && claims.email && claims.email_verified ? String(claims.email).trim().toLowerCase() : null;
  if (!em) return false;
  const h = await sha256Hex(em);
  if (p.emailHash === h) return true;
  const writes = [{ update: { name: DOC_ROOT + "/emails/" + h, fields: { uid: { stringValue: uid }, ts: { integerValue: String(Date.now()) } } } },
                  { update: { name: DOC_ROOT + "/accounts/" + uid, fields: { emailHash: { stringValue: h } } }, updateMask: { fieldPaths: ["emailHash"] } }];
  if (p.emailHash) writes.push({ delete: DOC_ROOT + "/emails/" + p.emailHash });
  await fsCommit(token, writes);
  p.emailHash = h;
  return true;
}
function otpCode() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + (a[0] % 900000)); }
async function opPhoneStart(uid, payload, env, claims) {
  const cfg = verifyConfig(env);
  if (!cfg.whatsapp) return { enabled: false };
  if (!codeRate(uid, "otp", 6)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = await profileOf(token, uid);
  const code = otpCode(), now = Date.now(), exp = now + 15 * 60 * 1000;
  const writes = [{ update: { name: DOC_ROOT + "/otp/" + code, fields: { uid: { stringValue: uid }, phone: p.phone ? { stringValue: p.phone } : { nullValue: null }, exp: { integerValue: String(exp) }, at: { integerValue: String(now) } } } },
                  { update: { name: DOC_ROOT + "/accounts/" + uid, fields: { otp: { stringValue: code }, otpExp: { integerValue: String(exp) } } }, updateMask: { fieldPaths: ["otp", "otpExp"] } }];
  const acc = await fsGet(token, "accounts/" + uid).catch(() => null);
  const old = fstr(acc, "otp"); if (old && old !== code) writes.push({ delete: DOC_ROOT + "/otp/" + old });
  await fsCommit(token, writes);
  const text = "رمز سوا: SAWA-" + code;
  return { enabled: true, code, exp, link: "https://wa.me/" + cfg.waNumber + "?text=" + encodeURIComponent(text), text };
}
async function opPhoneStatus(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const d = await fsGet(token, "accounts/" + uid).catch(() => null);
  const v = fbool(d, "phoneVerified") === true, phone = fstr(d, "phone") || null;
  const c = PROFILE_CACHE.get(uid); if (c) { c.phoneVerified = v; c.phone = phone; }
  const exp = Number(d && d.fields && d.fields.otpExp && d.fields.otpExp.integerValue || 0);
  const vouches = phone ? await vouchCount(token, uid, phone) : { n: 0, names: [] };
  return { phone, phoneVerified: v, verifiedBy: v ? (fstr(d, "verifiedBy") || "whatsapp") : null, pending: !v && exp > Date.now(), mismatch: fstr(d, "otpMismatch") || null,
    vouches: vouches.n, vouchers: vouches.names, needed: VOUCH_NEEDED };
}
/* ---------- 44) تأكيد الرقم عبر المعارف (C44) ----------
   بلا Meta ولا SMS: صاحب الرقم يطلب من معارفه (جهات اتّصال متبادلة) تأكيد أنّ هذا رقمه. كلّ مؤكِّدٍ يجب أن يكون
   غير مجهول وموثَّق البريد (Google/بريد مؤكَّد) أو موثَّق الهاتف. تأكيدان من شخصين مختلفين للرقم الحاليّ ⇒ phoneVerified
   (verifiedBy = "contacts"). accounts/{to}/vouchin/{from} = طلب · accounts/{owner}/vouches/{voucher} = { phone, name, ts, matched } (C187: المسار السابق vouches/{owner}/{voucher} كان مساراً غير صالح لـ Firestore).
   تغيير الرقم يُبطل التأكيدات القديمة (تُحسب فقط التي تحمل الرقم الحاليّ). رقمٌ واحد لحسابٍ واحد (phones/). */
const VOUCH_NEEDED = 2;
async function vouchCount(token, owner, phone) {
  const vs = await fsList(token, "accounts/" + owner + "/vouches").catch(() => []);
  const names = [];
  for (const d of vs) if (fstr(d, "phone") === phone) names.push(fstr(d, "name") || null);
  return { n: names.length, names: names.slice(0, 5) };
}
async function opVouchRequest(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "vouch", 5)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = await profileOf(token, uid);
  if (!p.phone) throw new Error("no_phone");
  if (p.phoneVerified) return { already: true };
  const to = Array.from(new Set(((payload && payload.to) || []).map(String))).filter(t => t && t !== uid).slice(0, 5);
  if (!to.length) throw new Error("no_targets");
  const me = await myName(token, uid, claims), now = Date.now();
  const writes = [], sent = [], skipped = [];
  for (const t of to) {
    if (!(await sharesContact(token, uid, t)) || (await blockedBy(token, t, uid).catch(() => false))) { skipped.push(t); continue; }
    writes.push({ update: { name: DOC_ROOT + "/accounts/" + t + "/vouchin/" + uid, fields: { name: me ? { stringValue: me } : { nullValue: null }, phone: { stringValue: p.phone }, ts: { integerValue: String(now) } } } });
    sent.push(t);
  }
  if (writes.length) await fsCommit(token, writes);
  if (sent.length) {
    const job = pushTo(token, sent, strData({ t: "req", k: "vouch", from: uid, title: "تأكيد رقم في سوا", body: (me || "مستخدم سوا") + " يطلب منك تأكيد أنّ رقمه " + p.phone, ts: now })).catch(e => console.log("push:", e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    await sigTo(token, sent, "req");
  }
  return { sent: sent.length, skipped };
}
async function opVouchRespond(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const owner = String((payload && payload.for) || ""), ok = !!(payload && payload.ok), matched = !!(payload && payload.matched);
  if (!owner || owner === uid) throw new Error("bad_target");
  const rq = await fsGet(token, "accounts/" + uid + "/vouchin/" + owner);
  if (!rq) throw new Error("not_found");
  const del = { delete: DOC_ROOT + "/accounts/" + uid + "/vouchin/" + owner };
  if (!ok) { await fsCommit(token, [del]); return { done: true, counted: false }; }
  if (claims.firebase && claims.firebase.sign_in_provider === "anonymous") throw new Error("not_eligible");
  const mine = await profileOf(token, uid);
  if (!(claims.email && claims.email_verified) && !mine.phoneVerified) throw new Error("not_eligible");
  if (!(await sharesContact(token, uid, owner))) throw new Error("not_contact");
  const target = await fsGet(token, "accounts/" + owner);
  const tphone = fstr(target, "phone"), rqPhone = fstr(rq, "phone");
  if (!tphone || tphone !== rqPhone) { await fsCommit(token, [del]); return { done: true, counted: false, stale: true }; }
  const myNm = await myName(token, uid, claims);
  await fsCommit(token, [del, { update: { name: DOC_ROOT + "/accounts/" + owner + "/vouches/" + uid, fields: { phone: { stringValue: tphone }, name: myNm ? { stringValue: myNm } : { nullValue: null }, ts: { integerValue: String(Date.now()) }, matched: { booleanValue: matched } } } }]);
  const vc = await vouchCount(token, owner, tphone);
  let verified = fbool(target, "phoneVerified") === true, conflict = false;
  if (!verified && vc.n >= VOUCH_NEEDED) {
    const ownerOfPhone = fstr(await fsGet(token, "phones/" + tphone).catch(() => null), "uid");
    if (ownerOfPhone && ownerOfPhone !== owner) conflict = true;
    else {
      await fsCommit(token, [
        { update: { name: DOC_ROOT + "/accounts/" + owner, fields: { phoneVerified: { booleanValue: true }, verifiedBy: { stringValue: "contacts" }, phoneVerifiedAt: { integerValue: String(Date.now()) } } }, updateMask: { fieldPaths: ["phoneVerified", "verifiedBy", "phoneVerifiedAt"] } },
        { update: { name: DOC_ROOT + "/phones/" + tphone, fields: { uid: { stringValue: owner }, by: { stringValue: "contacts" }, ts: { integerValue: String(Date.now()) } } } }]);
      PROFILE_CACHE.delete(owner); verified = true;
      const job = pushTo(token, [owner], strData({ t: "vouchok", title: "تأكّد رقمك ✓", body: "أكّد اثنان من معارفك رقمك " + tphone + " — صار بإمكان معارفك إيجادك به", ts: Date.now() })).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
  }
  return { done: true, counted: true, count: vc.n, needed: VOUCH_NEEDED, verified, conflict };
}
// Meta ⇒ /wa/webhook : التحقّق (GET) والرسائل (POST)
async function waWebhook(request, env, ctx) {
  const u = new URL(request.url);
  if (request.method === "GET") {
    if (u.searchParams.get("hub.mode") === "subscribe" && env.WA_VERIFY_TOKEN && u.searchParams.get("hub.verify_token") === env.WA_VERIFY_TOKEN)
      return new Response(u.searchParams.get("hub.challenge") || "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("method", { status: 405 });
  if (!env.WA_APP_SECRET) return new Response("not configured", { status: 403 });
  const raw = await request.text();
  const sig = (request.headers.get("X-Hub-Signature-256") || "").replace(/^sha256=/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WA_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))).map(b => b.toString(16).padStart(2, "0")).join("");
  if (!sig || sig.length !== mac.length || !timingEq(sig, mac)) return new Response("bad signature", { status: 403 });
  let body = {}; try { body = JSON.parse(raw); } catch (e) {}
  const msgs = [];
  for (const e of (body.entry || [])) for (const ch of (e.changes || [])) for (const m of ((ch.value || {}).messages || [])) msgs.push(m);
  const job = (async () => {
    const token = await getAccessToken(JSON.parse(env.SA_JSON));
    for (const m of msgs.slice(0, 10)) {
      const from = String(m.from || "").replace(/\D/g, ""); if (!from) continue;
      const text = (m.text && m.text.body) || (m.button && m.button.text) || "";
      const mm = String(text).match(/SAWA\s*[-–—:]?\s*(\d{6})/i); if (!mm) continue;
      await waVerify(token, env, mm[1], "+" + from).catch(e => console.log("wa verify:", e && e.message));
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return new Response("ok", { status: 200 });
}
function timingEq(a, b) { let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function waVerify(token, env, code, from) {
  const o = await fsGet(token, "otp/" + code);
  const uid = fstr(o, "uid"); if (!uid) { await waReply(env, from, "الرمز غير معروف أو انتهى. افتح سوا ← حسابي ← تحقّق عبر واتساب واطلب رمزاً جديداً."); return; }
  const exp = Number(o.fields.exp && o.fields.exp.integerValue || 0);
  if (exp < Date.now()) { await fsCommit(token, [{ delete: DOC_ROOT + "/otp/" + code }]); await waReply(env, from, "انتهت صلاحيّة الرمز. اطلب رمزاً جديداً من سوا."); return; }
  const phone = cleanPhone(from); if (!phone) return;
  // من كان الرقم عنده موثَّقاً من قبل يفقده (رقمٌ واحد لحسابٍ واحد)
  const prevOwner = fstr(await fsGet(token, "phones/" + phone).catch(() => null), "uid");
  const writes = [
    { update: { name: DOC_ROOT + "/accounts/" + uid, fields: { phone: { stringValue: phone }, phoneVerified: { booleanValue: true }, verifiedBy: { stringValue: "whatsapp" }, phoneVerifiedAt: { integerValue: String(Date.now()) }, otp: { nullValue: null }, otpExp: { nullValue: null }, otpMismatch: { nullValue: null } } },
      updateMask: { fieldPaths: ["phone", "phoneVerified", "verifiedBy", "phoneVerifiedAt", "otp", "otpExp", "otpMismatch"] } },
    { update: { name: DOC_ROOT + "/phones/" + phone, fields: { uid: { stringValue: uid }, ts: { integerValue: String(Date.now()) } } } },
    { delete: DOC_ROOT + "/otp/" + code }];
  if (prevOwner && prevOwner !== uid) writes.push({ update: { name: DOC_ROOT + "/accounts/" + prevOwner, fields: { phoneVerified: { booleanValue: false } } }, updateMask: { fieldPaths: ["phoneVerified"] } });
  // الرقم القديم المكتوب في الحساب (إن اختلف) يفقد فهرسه إن كان لنا
  const oldPhone = fstr(o, "phone");
  if (oldPhone && oldPhone !== phone) { const op = await fsGet(token, "phones/" + oldPhone).catch(() => null); if (fstr(op, "uid") === uid) writes.push({ delete: DOC_ROOT + "/phones/" + oldPhone }); }
  await fsCommit(token, writes);
  PROFILE_CACHE.delete(uid); if (prevOwner) PROFILE_CACHE.delete(prevOwner);
  await waReply(env, from, "تمّ توثيق رقمك في سوا ✓ — عد إلى التطبيق.");
}
async function waReply(env, to, text) {
  if (!env.WA_TOKEN || !env.WA_PHONE_ID) return;
  try {
    await fetch("https://graph.facebook.com/v21.0/" + env.WA_PHONE_ID + "/messages", { method: "POST", headers: { Authorization: "Bearer " + env.WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: String(to).replace(/\D/g, ""), type: "text", text: { body: text } }) });
  } catch (e) { console.log("wa reply:", e && e.message); }
}
// البحث بالهاتف الموثَّق أو البريد الموثَّق — بالشكل نفسه الذي يعيده code.find
async function findTarget(token, uidHit) {
  if (!uidHit) return null;
  const acc = await fsGet(token, "accounts/" + uidHit);
  if (!acc || !accFindable(acc)) return null;
  return { uid: uidHit, code: fstr(acc, "code") || null, name: fstr(acc, "displayName") || fstr(acc, "gname") || null };
}
async function opFindBy(uid, payload, env, kind) {
  if (!codeRate(uid, "find", 30)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  let t = null;
  if (kind === "phone") {
    const ph = cleanPhone(payload && payload.phone); if (!ph) throw new Error("bad_phone");
    const d = await fsGet(token, "phones/" + ph).catch(() => null);
    t = await findTarget(token, fstr(d, "uid"));
    if (t) { const acc = await fsGet(token, "accounts/" + t.uid); if (fbool(acc, "phoneVerified") !== true || fstr(acc, "phone") !== ph) t = null; }
  } else {
    const em = String((payload && payload.email) || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error("bad_email");
    const d = await fsGet(token, "emails/" + await sha256Hex(em)).catch(() => null);
    t = await findTarget(token, fstr(d, "uid"));
  }
  if (!t) return { found: false };
  if (t.uid === uid) return { found: true, self: true, name: t.name, code: t.code };
  const [contact, outR, inR] = await Promise.all([sharesContact(token, uid, t.uid),
    fsGet(token, "accounts/" + uid + "/creqout/" + t.uid), fsGet(token, "accounts/" + uid + "/creq/" + t.uid)]);
  return { found: true, name: t.name, code: t.code, contact: !!contact, pending: inR ? "in" : outR ? "out" : null, uid: (contact || inR || outR) ? t.uid : undefined };
}
async function opProfileSet(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  payload = payload || {};
  const fields = {}, mask = [];
  let name, phone;
  if ("name" in payload) {
    name = String(payload.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (name.length < 2) throw new Error("الاسم قصيرٌ جدّاً");
    fields.displayName = { stringValue: name }; mask.push("displayName");
  }
  if ("phone" in payload) {
    if (payload.phone === null || payload.phone === "") phone = "";
    else { phone = cleanPhone(payload.phone); if (!phone) throw new Error("رقم الهاتف غير صحيح — مثال: +249912345678"); }
    fields.phone = phone ? { stringValue: phone } : { nullValue: null }; fields.phoneVerified = { booleanValue: false }; mask.push("phone", "phoneVerified");
  }
  // v37: صورة الحساب — avatars/{uid} = { d: data:image/… (≤ ٢٠ ألف حرف)، ts } يقرؤها كلّ مسجَّل (القواعد)، والخادم وحده يكتبها
  let photo;
  if ("photo" in payload) {
    if (payload.photo === null || payload.photo === "") photo = "";
    else {
      photo = String(payload.photo);
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 20000) throw new Error("bad photo");
    }
    fields.photoTs = photo ? { integerValue: String(Date.now()) } : { nullValue: null }; mask.push("photoTs");
  }
  if (!mask.length) throw new Error("nothing to change");
  const pw = [{ update: { name: DOC_ROOT + "/accounts/" + uid, fields }, updateMask: { fieldPaths: mask } }];
  if (phone !== undefined) {   // C43: الرقم الموثَّق القديم يفقد فهرسه (إن كان لي)؛ الرقم الجديد غير موثَّق حتّى يُتحقَّق
    const pv0 = PROFILE_CACHE.get(uid) || await profileOf(token, uid);
    if (pv0.phone && pv0.phone !== phone) { const op = await fsGet(token, "phones/" + pv0.phone).catch(() => null); if (fstr(op, "uid") === uid) pw.push({ delete: DOC_ROOT + "/phones/" + pv0.phone }); }
    if (pv0.phone === phone && pv0.phoneVerified) { delete fields.phoneVerified; const i = mask.indexOf("phoneVerified"); if (i >= 0) mask.splice(i, 1); }   // الرقم نفسه ⇒ يبقى موثَّقاً
  }
  if (photo !== undefined) pw.push(photo ? { update: { name: DOC_ROOT + "/avatars/" + uid, fields: { d: { stringValue: photo }, ts: { integerValue: String(Date.now()) } } } } : { delete: DOC_ROOT + "/avatars/" + uid });
  await fsCommit(token, pw);
  if (name === undefined && phone === undefined) { const pv = PROFILE_CACHE.get(uid) || {}; return { profile: { name: pv.name || null, phone: pv.phone || null, phoneVerified: false, photo: !!photo }, propagated: 0 }; }
  const prev = PROFILE_CACHE.get(uid) || {};
  PROFILE_CACHE.set(uid, Object.assign({}, prev, { name: name !== undefined ? name : prev.name || null, phone: phone !== undefined ? (phone || null) : prev.phone || null,
    phoneVerified: phone !== undefined && phone !== prev.phone ? false : !!prev.phoneVerified, at: prev.at || Date.now() }));
  // النشر: عضويّاتي في العائلات · أسمائي في المحادثات · بطاقتي عند جهات اتّصالي (حدّ ٥٠ طلباً فرعيّاً)
  const pf = {}, pm = [];
  if (name !== undefined) { pf.name = { stringValue: name }; pm.push("name"); }
  if (phone !== undefined) { pf.phone = phone ? { stringValue: phone } : { nullValue: null }; pm.push("phone"); }
  let n = 0;
  for (const d of (await fsList(token, "accounts/" + uid + "/groups")).slice(0, 14)) {
    const gid = d.name.split("/").pop();
    try { await fsCommit(token, [{ update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid, fields: pf }, updateMask: { fieldPaths: pm }, currentDocument: { exists: true } }]); n++; } catch (e) {}
  }
  if (name !== undefined) {
    try {
      const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "chats" }], where: { fieldFilter: { field: { fieldPath: "members" }, op: "ARRAY_CONTAINS", value: { stringValue: uid } } }, limit: 80 } }) });
      const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
      const w = rows.map(c => ({ update: { name: c.name, fields: { names: { mapValue: { fields: { [uid]: { stringValue: name } } } } } }, updateMask: { fieldPaths: [fp("names", uid)] } }));
      for (let i = 0; i < w.length; i += 20) await fsCommit(token, w.slice(i, i + 20));
      n += rows.length;
    } catch (e) {}
  }
  for (const d of (await fsList(token, "accounts/" + uid + "/people")).slice(0, 12)) {
    const other = d.name.split("/").pop();
    try { await fsCommit(token, [{ update: { name: DOC_ROOT + "/accounts/" + other + "/people/" + uid, fields: pf }, updateMask: { fieldPaths: pm }, currentDocument: { exists: true } }]); n++; } catch (e) {}
  }
  return { profile: { name: name !== undefined ? name : prev.name || null, phone: phone !== undefined ? (phone || null) : prev.phone || null, phoneVerified: !!(PROFILE_CACHE.get(uid) || {}).phoneVerified }, propagated: n };
}

/* ---------- 29) المكالمات (C6) ----------
   الإشارات (العرض/الردّ/المرشّحون) في Realtime Database مباشرةً بين الجهازين (calls/{id} + inbox/{uid}) — القواعد تقصرها على
   جهات الاتّصال (acl). الـWorker: بيانات TURN · رنينٌ عبر الإشعارات حين يكون التطبيق مغلقاً · إشعار «مكالمة فائتة». */
let iceCache = null, iceAt = 0;
// P1: Cloudflare Realtime TURN (١٠٠٠ GB/شهر مجّاناً) — سرّان في Cloudflare: CF_TURN_KEY_ID و CF_TURN_API_TOKEN.
// بيانات دخولٍ مؤقّتة (٢٤ ساعة) تُجدَّد كلّ ٦ ساعات وتُشارَك بين الطلبات. فشلها ⇒ نرجع إلى Metered تلقائيّاً.
// TURN_PROVIDER = "metered" (متغيّرٌ اختياريّ) يُجبر الرجوع إلى Metered دون حذف الأسرار.
// v33: بيانات دخولٍ لكلّ مستخدم (صلاحيتها ٦ ساعات، تُعاد له خلال ساعتين) بدل بياناتٍ واحدة لكلّ الناس ٢٤ ساعة —
//      تسرُّبها لا يفتح المرحِّل للجميع، وصلاحيّتها قصيرة. والضيف المجهول بحدٍّ أضيق (لكلّ حساب ولكلّ عنوان IP).
const iceByUid = new Map(), iceHits = new Map();
function iceRateOk(key, max) {
  const now = Date.now(), h = iceHits.get(key);
  if (!h || now - h.t > 3600000) { iceHits.set(key, { t: now, n: 1 }); if (iceHits.size > 20000) iceHits.clear(); return true; }
  return ++h.n <= max;
}
async function cloudflareIce(env, uid) {
  const hit = uid && iceByUid.get(uid);
  if (hit && Date.now() - hit.at < 2 * 3600 * 1000) return hit.list;
  const res = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(String(env.CF_TURN_KEY_ID).trim()) + "/credentials/generate-ice-servers", {
    method: "POST", headers: { Authorization: "Bearer " + String(env.CF_TURN_API_TOKEN).trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 6 * 3600 }) });
  let b = null; try { b = await res.json(); } catch (e) {}
  if (!res.ok || !b || !Array.isArray(b.iceServers)) throw new Error("cloudflare turn " + res.status);
  // المنفذ 53 تحجبه المتصفّحات (ينتظر حتّى المهلة) — نحذفه
  const list = b.iceServers.map(x => Object.assign({}, x, { urls: [].concat(x.urls || []).filter(u => !/:53(\?|$)/.test(String(u))) }))
    .filter(x => x.urls.length);
  if (!list.some(x => x.username && x.credential)) throw new Error("cloudflare turn: no credentials");
  if (uid) { if (iceByUid.size > 5000) iceByUid.clear(); iceByUid.set(uid, { list, at: Date.now() }); }
  return list;
}
// C178: مراقبة الخدمات — كلّ خدمةٍ تُفحص وحدها: Firestore (الرسائل والبيانات) · RTDB (الإشارات) · وسطاء TURN (Metered بطلب STUN حقيقيّ عبر TCP،
//       Cloudflare بإصدار بيانات الدخول) · خادم الوسائط SFU · الإشعارات (FCM). النتيجة في health/now مع آخر ٧٢ قياساً لكلّ خدمة،
//       وإشعارٌ للمدير حين تتعطّل خدمة (بعد إعادة فحصٍ تؤكّد العطل) وحين تعود.
const HEALTH_LABELS = { firestore: "الرسائل والبيانات (Firestore)", rtdb: "إشارات المكالمات (RTDB)", cfturn: "وسيط Cloudflare", sfu: "خادم الوسائط (SFU)", fcm: "الإشعارات (FCM)" };
async function stunTcp(host, port) {
  const t0 = Date.now();
  const sock = connect({ hostname: host, port });
  const w = sock.writable.getWriter(), r = sock.readable.getReader();
  const req = new Uint8Array(20), dv = new DataView(req.buffer);
  dv.setUint16(0, 0x0001); dv.setUint16(2, 0); dv.setUint32(4, 0x2112A442); crypto.getRandomValues(req.subarray(8));
  try {
    await w.write(req);
    const res = await Promise.race([r.read(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))]);
    const v = res && res.value;
    if (!v || v.length < 2) throw new Error("no reply");
    if (((v[0] << 8) | v[1]) !== 0x0101) throw new Error("bad stun reply");
    return Date.now() - t0;
  } finally { try { await sock.close(); } catch (e) {} }
}
async function fcmProbe(token) {   // تحقّقٌ بلا إرسال (validate_only إلى موضوعٍ وهميّ)
  const t0 = Date.now();
  const res = await fetch("https://fcm.googleapis.com/v1/projects/" + PROJECT_ID + "/messages:send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ validate_only: true, message: { topic: "sawa-health", data: { t: "health" } } }) });
  if (!res.ok) throw new Error("fcm " + res.status + " " + (await res.text()).slice(0, 80));
  return Date.now() - t0;
}
async function healthRun(env, opts) {
  opts = opts || {};
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const name = DOC_ROOT + "/health/now";
  const prevDoc = await fsGet(token, "health/now").catch(() => null);
  const prev = prevDoc ? { svc: JSON.parse(fstr(prevDoc, "svc") || "{}"), hist: JSON.parse(fstr(prevDoc, "hist") || "{}"), admin: fstr(prevDoc, "admin") } : { svc: {}, hist: {}, admin: "" };
  if (!opts.manual && prevDoc && Date.now() - fsInt(prevDoc, "at") < 270000) return { at: fsInt(prevDoc, "at"), svc: prev.svc, hist: prev.hist, skipped: true };   // C180: كلّ ٥ دقائق مهما تكرّر المجدوِل
  const probes = {
    firestore: async () => { await fsGet(token, "config/relay"); },
    rtdb: async () => { await rtdbGet(token, "health"); },
  };
  if ((env.METERED_USER && env.METERED_PASS) || (env.METERED_KEY && env.METERED_APP)) {
    const hosts = String(env.METERED_HOSTS || env.METERED_HOST || METERED_DEFAULT_HOSTS).split(/[\s,]+/).filter(h => /^[a-z0-9.-]{3,80}$/i.test(h)).slice(0, 3);
    for (const h of hosts) probes["metered:" + h.split(".")[0]] = () => stunTcp(h, 80);
  }
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) probes.cfturn = async () => { await cloudflareIce(env, null); };
  if (sfuOn(env)) probes.sfu = async () => { const j = await sfuApi(env, "POST", "/sessions/new"); if (!j || !j.sessionId) throw new Error("no session"); };
  probes.fcm = () => fcmProbe(token);
  const run = async (fn) => { const t0 = Date.now(); try { const ms = await fn(); return { ok: true, ms: typeof ms === "number" ? ms : Date.now() - t0 }; } catch (e) { return { ok: false, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 140) }; } };
  const names = Object.keys(probes), out = {};
  const first = await Promise.all(names.map(k => run(probes[k])));
  for (let i = 0; i < names.length; i++) {
    let r = first[i];
    if (!r.ok) { await new Promise(res => setTimeout(res, 1500)); r = await run(probes[names[i]]); }   // إعادة فحصٍ قبل الحكم بالعطل
    out[names[i]] = r;
  }
  const now = Date.now(), svc = {}, hist = {}, down = [], up = [];
  for (const k of names) {
    const p = prev.svc[k] || {}, r = out[k];
    svc[k] = { ok: r.ok, ms: r.ms, err: r.err || null, since: (p.ok === r.ok && p.since) ? p.since : now, at: now };
    hist[k] = ((prev.hist[k] || []).concat([[now, r.ok ? r.ms : -1]])).slice(-72);
    if (p.ok !== false && !r.ok) down.push(k); else if (p.ok === false && r.ok) up.push(k);
  }
  await fsCommit(token, [{ update: { name, fields: { at: { integerValue: String(now) }, svc: { stringValue: JSON.stringify(svc) }, hist: { stringValue: JSON.stringify(hist) }, admin: { stringValue: opts.admin || prev.admin || "" } } },
    updateMask: { fieldPaths: ["at", "svc", "hist", "admin"] } }]);   // C181: لا تمسح حقول الملخّص اليوميّ
  const admin = opts.admin || prev.admin;
  const lbl = (k) => HEALTH_LABELS[k] || (k.indexOf("metered:") === 0 ? "وسيط Metered (" + k.slice(8) + ")" : k);
  if (admin && !opts.manual && (down.length || up.length)) {
    const body = (down.length ? "⛔ متعطّل: " + down.map(lbl).join("، ") + (out[down[0]].err ? " — " + out[down[0]].err : "") : "") + (up.length ? (down.length ? "\n" : "") + "✅ عاد: " + up.map(lbl).join("، ") : "");
    await pushTo(token, [admin], strData({ t: "health", title: down.length ? "⚠️ سوا: خدمة متعطّلة" : "✅ سوا: عادت الخدمة", body, ts: now })).catch(() => {});
  }
  return { at: now, svc, hist };
}
async function opAdminHealth(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  if (payload && payload.run) { const r = await healthRun(env, { admin: uid, manual: true }); return Object.assign({ admin: true, labels: HEALTH_LABELS }, r); }
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const d = await fsGet(token, "health/now").catch(() => null);
  if (!d || fstr(d, "admin") !== uid) {   // أوّل فتحٍ للشاشة يسجّل المدير لتصله التنبيهات
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/health/now", fields: { admin: { stringValue: uid } } }, updateMask: { fieldPaths: ["admin"] } }]).catch(() => {});
  }
  return { admin: true, labels: HEALTH_LABELS, at: d ? fsInt(d, "at") : 0, svc: d ? JSON.parse(fstr(d, "svc") || "{}") : {}, hist: d ? JSON.parse(fstr(d, "hist") || "{}") : {} };
}

// C178: مضيفو Metered الإقليميّون — العامّ (يوجّه للأقرب) + الشرق الأوسط + وسط أوروبا. التطبيق يقيس زمن كلّ واحدٍ من شبكة الهاتف
//       ويستعمل أسرع اثنين (relayIce). المتغيّر METERED_HOSTS يغلب هذه القائمة. (الأقاليم في الخطط المدفوعة؛ ما يفشل قياسه لا يُستعمل)
const METERED_DEFAULT_HOSTS = "global.relay.metered.ca,middle-east.relay.metered.ca,eu-central.relay.metered.ca";
// C179: Metered — بيانات دخولٍ مؤقّتة لكلّ مستخدم عبر TURN REST API (تنتهي بعد ٧٢ ساعة، تُجدَّد حين يبقى أقلّ من ٢٤ ساعة).
//       الجديدة تحتاج حتّى دقيقتين لتنتشر على خوادم Metered ⇒ تبقى القديمة مستعملةً حتّى تنتشر الجديدة. turncred/{uid} للخادم وحده.
const MCRED_TTL = 72 * 3600, MCRED_RENEW = 24 * 3600 * 1000, MCRED_PROP = 150 * 1000;
const MCRED_MEM = new Map();
async function meteredCred(env, uid) {
  const now = Date.now(), mem = MCRED_MEM.get(uid);
  if (mem && mem.exp - now > MCRED_RENEW && now - mem.at > MCRED_PROP) return mem;
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const d = await fsGet(token, "turncred/" + uid).catch(() => null);
  let c = d && fstr(d, "c") ? JSON.parse(fstr(d, "c")) : null, n = d && fstr(d, "n") ? JSON.parse(fstr(d, "n")) : null, dirty = false;
  if (n && now - n.at > MCRED_PROP) { c = n; n = null; dirty = true; }
  if (c && c.exp <= now + 10 * 60000) { c = null; dirty = true; }
  if (!n && (!c || c.exp - now < MCRED_RENEW)) {
    const res = await fetch("https://" + String(env.METERED_APP).trim() + ".metered.live/api/v1/turn/credential?secretKey=" + encodeURIComponent(String(env.METERED_SECRET).trim()), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiryInSeconds: MCRED_TTL, label: "sawa-" + uid.slice(0, 40) }) });
    let b = null; try { b = await res.json(); } catch (e) {}
    if (!res.ok || !b || !b.username || !b.password) throw new Error("metered credential " + res.status);
    n = { u: b.username, p: b.password, exp: now + MCRED_TTL * 1000, at: now }; dirty = true;
    stat("turn:mnew");
  }
  if (dirty) await fsCommit(token, [{ update: { name: DOC_ROOT + "/turncred/" + uid, fields: { c: { stringValue: c ? JSON.stringify(c) : "" }, n: { stringValue: n ? JSON.stringify(n) : "" }, ts: { integerValue: String(now) } } } }]).catch(() => {});
  const use = c && c.exp - now > 10 * 60000 ? c : Object.assign({ fresh: now - n.at < MCRED_PROP }, n);   // القديمة ما دامت صالحة حتّى تنتشر الجديدة
  if (use === c && !n) MCRED_MEM.set(uid, c);
  if (MCRED_MEM.size > 5000) MCRED_MEM.clear();
  return use;
}
// C175: الوسيط الأساسيّ يبدّله المدير من هاتفه — config/relay.primary = "m" | "cf" | "" (تلقائيّ = TURN_PROVIDER في الـWorker)
let RELAY_CFG = null, RELAY_AT = 0;
async function relayPref(env) {
  if (RELAY_CFG !== null && Date.now() - RELAY_AT < 60000) return RELAY_CFG;
  try { const token = await getAccessToken(JSON.parse(env.SA_JSON)); const d = await fsGet(token, "config/relay"); RELAY_CFG = (d && fstr(d, "primary")) || ""; }
  catch (e) { RELAY_CFG = RELAY_CFG || ""; }
  RELAY_AT = Date.now(); return RELAY_CFG;
}
async function opAdminRelay(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  if (payload && payload.primary !== undefined) {
    const v = payload.primary === "m" || payload.primary === "cf" ? payload.primary : "";
    const token = await getAccessToken(JSON.parse(env.SA_JSON));
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/config/relay", fields: { primary: { stringValue: v }, by: { stringValue: uid }, ts: { integerValue: String(Date.now()) } } } }]);
    RELAY_CFG = v; RELAY_AT = Date.now();
  }
  return { admin: true, primary: await relayPref(env), envDefault: env.TURN_PROVIDER === "cloudflare" ? "cf" : "m",
    has: { m: !!((env.METERED_USER && env.METERED_PASS) || (env.METERED_KEY && env.METERED_APP)), cf: !!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) } };
}
async function opRtcIce(uid, payload, env, claims, request) {
  const stun = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  const anon = !!(claims && claims.firebase && claims.firebase.sign_in_provider === "anonymous");
  const ip = (request && request.headers.get("CF-Connecting-IP")) || "?";
  // حدّ الطلبات الجديدة (ما في الذاكرة لا يُحسب): المسجَّل ٢٠/ساعة · الضيف ٦/ساعة و٢٠ لكلّ عنوان IP
  const cached = iceByUid.get(uid);
  if (!(cached && Date.now() - cached.at < 2 * 3600 * 1000)) {
    if (!iceRateOk("u:" + uid, anon ? 6 : 20) || (anon && !iceRateOk("ip:" + ip, 20))) { stat("turn:limited"); return { iceServers: stun, turn: false, limited: true }; }
  }
  // v60 (C94): عدّة وسطاء — يُعاد كلّ وسيطٍ متاح في «relays» ليقيس التطبيق أقربها لشبكته ويختاره (أو يختار المستخدم يدويّاً).
  //   Cloudflare (CF_TURN_*) · Metered (METERED_USER/PASS مع METERED_HOSTS: مضيفون مفصولون بفاصلة، أو METERED_HOST) أو مفتاح API
  //   · وسطاء إضافيّون في السرّ TURN_EXTRA: [{"label":"…","urls":[…],"username":"…","credential":"…"}]
  //   iceServers = STUN + كلّ الوسطاء (الترتيب الافتراضيّ) للنسخ القديمة.
  const relays = []; let cfErr = null, mErr = null;
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    try { relays.push({ id: "cf", label: "Cloudflare", iceServers: await cloudflareIce(env, uid) }); }
    catch (e) { cfErr = String((e && e.message) || e); console.log("cf turn:", cfErr); }
  }
  // C179: بيانات دخولٍ مؤقّتة لكلّ مستخدم (METERED_SECRET + METERED_APP) بدل الاسم وكلمة المرور الثابتين — والثابتة احتياطٌ إن تعذّر الإنشاء
  let mc = null;
  if (env.METERED_SECRET && env.METERED_APP && uid) { try { mc = await meteredCred(env, uid); } catch (e) { mErr = String((e && e.message) || e); console.log("metered cred:", mErr); } }
  if ((!mc || mc.fresh) && env.METERED_USER && env.METERED_PASS) mc = { u: env.METERED_USER, p: env.METERED_PASS, fixed: true };   // أوّل دقيقتين لبيانات المستخدم الجديدة: الثابتة إن وُجدت
  if (mc) {
    const hosts = String(env.METERED_HOSTS || env.METERED_HOST || METERED_DEFAULT_HOSTS).split(/[\s,]+/).filter(h => /^[a-z0-9.-]{3,80}$/i.test(h)).slice(0, 6);
    for (const h of hosts) relays.push({ id: "m:" + h, label: "Metered " + (h.split(".")[0] === "global" ? "global" : h.split(".")[0]),
      iceServers: [{ urls: ["turn:" + h + ":80", "turn:" + h + ":80?transport=tcp", "turn:" + h + ":443", "turns:" + h + ":443?transport=tcp"], username: mc.u, credential: mc.p }] });
    stat(mc.fixed ? "turn:mfixed" : "turn:mtemp");
  } else if (env.METERED_KEY && env.METERED_APP) {
    try {
      if (!(iceCache && Date.now() - iceAt < 30 * 60 * 1000)) {
        const res = await fetch("https://" + env.METERED_APP + ".metered.live/api/v1/turn/credentials?apiKey=" + encodeURIComponent(env.METERED_KEY));
        const list = await res.json();
        if (!res.ok || !Array.isArray(list)) throw new Error("metered " + res.status);
        iceCache = list.filter(x => [].concat(x.urls || []).some(u => /^turns?:/.test(String(u)))); iceAt = Date.now();
      }
      if (iceCache.length) relays.push({ id: "metered", label: "Metered", iceServers: iceCache });
    } catch (e) { mErr = String((e && e.message) || e); }
  }
  if (env.TURN_EXTRA) {
    try {
      const ex = JSON.parse(env.TURN_EXTRA);
      (Array.isArray(ex) ? ex : []).slice(0, 6).forEach((x, i) => {
        const urls = [].concat((x && x.urls) || []).map(String).filter(u => /^turns?:/.test(u) && !/:53(\?|$)/.test(u));
        if (urls.length) relays.push({ id: "x" + i, label: String(x.label || "TURN " + (i + 1)).slice(0, 30), iceServers: [{ urls, username: x.username, credential: x.credential }] });
      });
    } catch (e) { console.log("TURN_EXTRA:", String(e.message || e)); }
  }
  // C165: Metered هو الوسيط الأساسيّ و Cloudflare احتياطٌ إن فشل (للمقارنة) · TURN_PROVIDER = "cloudflare" يعكس الترتيب
  const want = (await relayPref(env).catch(() => "")) || (env.TURN_PROVIDER === "cloudflare" ? "cf" : "m");   // C175: اختيار المدير يغلب
  const hasM = relays.some(r => /^m/.test(r.id)), hasCf = relays.some(r => r.id === "cf");
  const primary = (want === "cf" && hasCf) || !hasM ? "cf" : "m";
  const isP = (r) => primary === "cf" ? r.id === "cf" : /^m/.test(r.id);
  relays.sort((a, b) => (isP(b) ? 1 : 0) - (isP(a) ? 1 : 0));
  if (!relays.length) return Object.assign({ iceServers: stun, turn: false }, cfErr ? { cfErr } : {}, mErr ? { err: mErr } : {});
  stat("turn:" + relays[0].id.split(":")[0]);
  const all = []; relays.forEach(r => r.iceServers.forEach(x => all.push(x)));
  // iceServers (للنسخ القديمة): الأساسيّ وحده إن وُجد، فلا يختار الهاتف غيره إلّا إن فشل
  const prim = relays.filter(isP), base = prim.length ? prim : relays;
  const bl = []; base.forEach(r => r.iceServers.forEach(x => bl.push(x)));
  return Object.assign({ turn: true, provider: relays[0].id === "cf" ? "cloudflare" : "metered", primary: primary === "cf" ? "cf" : "m", iceServers: stun.concat(bl), relays }, cfErr ? { cfErr } : {});
}
const RING_REPEATS = 3, RING_GAP_MS = (typeof globalThis !== "undefined" && globalThis.__RING_GAP_MS) || 8000;
async function opCallRing(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const to = payload && payload.to, callId = String((payload && payload.callId) || "");
  if (!segOk(String(to || "")) || !/^[A-Za-z0-9_-]{6,40}$/.test(callId)) throw new Error("bad call");
  if (!(await sharesContact(token, uid, to))) throw new Error("not a contact");
  // المحظور لا يرنّ عند من حظره
  const pr = await fsGet(token, "accounts/" + to + "/chatprefs/main");
  const blocked = pr && fstr(pr, "data") ? (JSON.parse(fstr(pr, "data")).blocked || []) : [];
  if (blocked.indexOf(uid) >= 0) return { queued: true };   // v33: الردّ نفسه — لا يعرف المحظور أنّه محظور
  // v33: لا إشعار «مكالمة واردة» بلا مكالمةٍ حقيقيّة ترنّ منّي إليه (كان يمكن إغراق أحدٍ بإشعارات رنينٍ وهميّة)
  const call = await rtdbGet(token, "calls/" + callId).catch(() => null);
  if (!call || call.from !== uid || call.to !== to || call.state !== "ringing") return { queued: true };
  const name = memberIdFields(claims).name.stringValue || "سوا";
  const video = payload.type === "video";
  const rk = await ackSig(env, "r|" + callId + "|" + to);   // v65: الجهاز يُقرّ «رنّت» ⇒ المتّصل يرى «يرنّ…»
  const data = (n) => strData({ t: "call", call: callId, from: uid, cid: dmId(uid, to), type: video ? "video" : "audio",
    title: name, body: (video ? "📹 مكالمة فيديو واردة" : "📞 مكالمة صوتيّة واردة") + (n ? " · " + "●".repeat(n) : ""), ts: Date.now(), ring: String(n), to: to, rk: rk });
  // C71: رنينٌ متكرّر كتطبيقات المكالمات — إشعارٌ كلّ ٨ ثوانٍ (بالوسم نفسه مع renotify ⇒ صوتٌ واهتزازٌ من جديد) ما دامت المكالمة ترنّ، حتى ~٢٤ ث
  const job = (async () => {
    let sent = await pushTo(token, [to], data(0));
    for (let n = 1; n <= RING_REPEATS; n++) {
      await new Promise((r) => setTimeout(r, RING_GAP_MS));
      const c = await rtdbGet(token, "calls/" + callId).catch(() => null);
      if (!c || c.state !== "ringing" || c.acc) break;
      sent += await pushTo(token, [to], data(n));
    }
    await telWrite(token, callId, "srv", uid, { ev: "ring", sent, video }).catch(() => {});   // C179: حدث البنية تحت معرّف المكالمة نفسه
    return sent;
  })();
  if (ctx && ctx.waitUntil) { ctx.waitUntil(job.catch(() => {})); return { queued: true }; }
  return { sent: await job };
}
// C179: سجلّ كلّ مكالمة — يرسله كلّ طرفٍ عند انتهائها (tel/{callId}~{طرف}) ويضيف الخادم أحداثه (الرنين) تحت المعرّف نفسه.
//       للمدير: admin.tel يجمعها بالمعرّف (نسبة المرور عبر TURN · UDP · زمن الاتّصال · RTT/الفقد/التذبذب · أسباب الفشل). تُحذف بعد ٣٠ يوماً.
const TEL_ID = /^[A-Za-z0-9_-]{4,60}$/;
async function telWrite(token, cid, side, uid, d) {
  const id = (cid + "~" + side).replace(/[^A-Za-z0-9_~-]/g, "").slice(0, 120);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/tel/" + id, fields: { cid: { stringValue: cid }, side: { stringValue: side }, by: { stringValue: uid }, ts: { integerValue: String(Date.now()) }, d: { stringValue: JSON.stringify(d).slice(0, 3000) } } } }]);
}
async function opCallTel(uid, payload, env) {
  if (!codeRate(uid, "tel", 80)) return { ok: false };
  const p = payload || {}, cid = String(p.id || "");
  if (!TEL_ID.test(cid)) throw new Error("bad id");
  const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
  const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : null; };
  const d = { k: str(p.k, 16), role: str(p.role, 10), eng: str(p.eng, 12), mode: str(p.mode, 6), plat: str(p.plat, 30), model: str(p.model, 40), ver: str(p.ver, 12), net: str(p.net, 16),
    ok: !!p.ok, setup: num(p.setup, 0, 120000), secs: num(p.secs, 0, 86400), reason: str(p.reason, 16), route: str(p.route, 8), proto: str(p.proto, 6), relay: str(p.relay, 32),
    n: num(p.n, 0, 50), rst: num(p.rst, 0, 100), err: str(p.err, 40), up: p.up ? 1 : 0, ck: p.ck ? 1 : 0, vis: p.vis ? 1 : 0, rtt: qaStatClean(p.rtt), jit: qaStatClean(p.jit), loss: qaStatClean(p.loss), jb: qaStatClean(p.jb), fps: qaStatClean(p.fps), h: qaStatClean(p.h) };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  await telWrite(token, cid, uid.slice(0, 10), uid, d);
  stat("tel:" + (d.ok ? (d.route || "ok") : "fail"));
  return { ok: true };
}
async function opAdminTel(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  const days = Math.max(1, Math.min(30, Number((payload && payload.days) || 7)));
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const r = await telAnalyze(token, Date.now() - days * 86400000);
  const h = await fsGet(token, "health/now").catch(() => null);
  return Object.assign({ admin: true, days, qoff: !!(h && fbool(h, "qoff")) }, r);
}
// C181: تحليل سجلّات المكالمات منذ وقتٍ معيّن (يستعمله تقرير المدير والملخّص اليوميّ والتنبيه)
async function telAnalyze(token, since) {
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "tel" }], where: { fieldFilter: { field: { fieldPath: "ts" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(since) } } },
      orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }], limit: 800 } }) });
  const data = await res.json();
  if (!res.ok) throw new Error("firestore query: " + JSON.stringify(data).slice(0, 200));
  const by = {};
  for (const r of (data || [])) {
    if (!r.document) continue;
    const f = r.document, cid = fstr(f, "cid"), side = fstr(f, "side"), ts = fsInt(f, "ts");
    let d = {}; try { d = JSON.parse(fstr(f, "d") || "{}"); } catch (e) {}
    const c = by[cid] || (by[cid] = { cid, ts, sides: [], srv: null });
    c.ts = Math.max(c.ts, ts);
    if (side === "srv") c.srv = d; else c.sides.push(Object.assign({ by: fstr(f, "by").slice(0, 6) }, d));
  }
  const calls = Object.values(by).filter(c => c.sides.length).sort((a, b) => b.ts - a.ts);
  const med = (a) => { a = a.filter(x => typeof x === "number").sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const p90 = (a) => { a = a.filter(x => typeof x === "number").sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : null; };
  const sum = (list) => {
    const conn = list.filter(c => c.sides.some(x => x.ok));
    const relay = conn.filter(c => c.sides.some(x => x.route === "relay"));
    const tcp = conn.filter(c => c.sides.some(x => x.proto && x.proto !== "udp"));
    const reasons = {}; list.filter(c => !c.sides.some(x => x.ok)).forEach(c => { const r = c.sides[0].reason || "?"; reasons[r] = (reasons[r] || 0) + 1; });
    const sv = (k) => conn.map(c => med(c.sides.map(x => x[k] && x[k].med)));
    return { n: list.length, conn: conn.length, relay: relay.length, tcp: tcp.length, setup: med(conn.map(c => med(c.sides.map(x => x.setup)))), setup90: p90(conn.map(c => med(c.sides.map(x => x.setup)))),
      rtt: med(sv("rtt")), loss: med(sv("loss")), jit: med(sv("jit")), fps: med(conn.filter(c => /video/.test(c.sides[0].k)).map(c => med(c.sides.map(x => x.fps && x.fps.med)))), reasons,
      ringOk: list.filter(c => c.srv && c.srv.sent > 0).length, ringN: list.filter(c => c.srv).length };
  };
  const one = calls.filter(c => /^(audio|video)$/.test(c.sides[0].k));
  const plats = {}; one.forEach(c => c.sides.forEach(x => { const k = x.plat || "?"; (plats[k] = plats[k] || []).push(c); }));
  const byPlat = {}; for (const k in plats) byPlat[k] = sum(Array.from(new Set(plats[k])));
  const groups = calls.filter(c => !/^(audio|video)$/.test(c.sides[0].k));
  return { all: sum(one), byPlat, groups: { n: groups.length, sfu: groups.filter(c => c.sides.some(x => x.mode === "sfu")).length, conn: groups.filter(c => c.sides.some(x => x.ok)).length },
    recent: calls.slice(0, 40) };
}
// C181: ملخّص الجودة اليوميّ للمدير (٧ صباحاً بتوقيت السودان، عن آخر ٢٤ ساعة) + تنبيهٌ فوريّ إن انهارت الجودة في آخر ساعتين.
//       الحدود: الاتّصال < ٨٥٪ · عبر TURN > ٤٠٪ · غير UDP > ١٥٪ · زمن الاتّصال > ٣ ث · وصول الرنين < ٩٠٪. المدير يوقفه من «سجلّ المكالمات».
const Q_TZ = 2 * 3600000, Q_HOUR = 5;   // UTC+2 · الساعة ٥ UTC = ٧ صباحاً
function qPct(a, b) { return b ? Math.round(a * 100 / b) : null; }
function qWarnings(a) {
  const w = [];
  if (a.n >= 5 && qPct(a.conn, a.n) < 85) w.push("الاتّصال " + qPct(a.conn, a.n) + "% (أقلّ من ٨٥٪)");
  if (a.conn >= 5 && qPct(a.relay, a.conn) > 40) w.push("عبر الوسيط " + qPct(a.relay, a.conn) + "% (أكثر من ٤٠٪)");
  if (a.conn >= 5 && qPct(a.tcp, a.conn) > 15) w.push("بلا UDP " + qPct(a.tcp, a.conn) + "%");
  if (a.setup != null && a.setup > 3000) w.push("زمن الاتّصال " + (a.setup / 1000).toFixed(1) + " ث");
  if (a.ringN >= 5 && qPct(a.ringOk, a.ringN) < 90) w.push("وصول الرنين " + qPct(a.ringOk, a.ringN) + "%");
  return w;
}
const Q_REASON = { hangup: "أُنهيت", remote: "أنهاها الآخر", noanswer: "لم يُجب", declined: "رُفضت", cancel: "أُلغيت", failed: "فشل الاتّصال", lost: "انقطعت", error: "خطأ", busy: "مشغول", missed: "فائتة" };
function qLine(a) {
  const top0 = Object.keys(a.reasons || {}).sort((x, y) => a.reasons[y] - a.reasons[x])[0], top = top0 ? (Q_REASON[top0] || top0) + " (" + a.reasons[top0] + ")" : "";
  return [a.n + " مكالمة", "اتّصلت " + (qPct(a.conn, a.n) ?? "–") + "%", "عبر الوسيط " + (qPct(a.relay, a.conn) ?? "–") + "%", "UDP " + (a.conn ? 100 - qPct(a.tcp, a.conn) : "–") + "%",
    a.setup != null ? "الاتّصال " + (a.setup / 1000).toFixed(1) + " ث" : "", a.rtt != null ? "RTT " + a.rtt + " ms" : "", a.loss != null ? "فقد " + a.loss + "%" : "", top ? "أكثر الفشل: " + top : ""].filter(Boolean).join(" · ");
}
async function qualityWatch(env, opts) {
  opts = opts || {};
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const h = await fsGet(token, "health/now").catch(() => null);
  const admin = h && fstr(h, "admin");
  if (!admin || (h && fbool(h, "qoff") && !opts.test)) return { skipped: true };
  const now = Date.now(), local = new Date(now + Q_TZ), day = local.toISOString().slice(0, 10), set = {};
  let sent = 0;
  if (opts.test || (new Date(now).getUTCHours() >= Q_HOUR && fstr(h, "qd") !== day)) {
    const r = await telAnalyze(token, now - 86400000), a = r.all, w = qWarnings(a), g = r.groups || {};
    if (a.n || g.n || opts.test) {
      const body = (a.n ? qLine(a) : "لا مكالمات فرديّة") + (g.n ? "\nالمجموعات والغرف: " + g.n + " (SFU " + (qPct(g.sfu, g.n) ?? 0) + "%)" : "") + (w.length ? "\n⚠️ " + w.join(" · ") : "");
      sent += await pushTo(token, [admin], strData({ t: "quality", title: (w.length ? "⚠️ " : "📊 ") + "سوا — جودة المكالمات أمس", body, ts: now }));
    }
    if (!opts.test) set.qd = { stringValue: day };
  }
  // التنبيه الفوريّ: كلّ ٣٠ دقيقة نفحص آخر ساعتين، ولا نكرّره قبل ٦ ساعات
  if (!opts.test && now - fsInt(h, "qc") > 30 * 60000) {
    set.qc = { integerValue: String(now) };
    if (now - fsInt(h, "qa") > 6 * 3600000) {
      const a = (await telAnalyze(token, now - 2 * 3600000)).all;
      const bad = (a.n >= 8 && qPct(a.conn, a.n) < 70) || (a.conn >= 8 && qPct(a.relay, a.conn) > 60) || (a.ringN >= 8 && qPct(a.ringOk, a.ringN) < 70);
      if (bad) {
        sent += await pushTo(token, [admin], strData({ t: "quality", title: "🚨 سوا — تراجعٌ في المكالمات الآن", body: "آخر ساعتين: " + qLine(a) + "\n" + qWarnings(a).join(" · "), ts: now }));
        set.qa = { integerValue: String(now) };
      }
    }
  }
  const keys = Object.keys(set);
  if (keys.length) await fsCommit(token, [{ update: { name: DOC_ROOT + "/health/now", fields: set }, updateMask: { fieldPaths: keys } }]);
  return { sent };
}
async function opAdminQcfg(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = payload || {}, fields = { admin: { stringValue: uid } }, mask = ["admin"];
  if (p.off !== undefined) { fields.qoff = { booleanValue: !!p.off }; mask.push("qoff"); }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/health/now", fields }, updateMask: { fieldPaths: mask } }]);
  const r = p.test ? await qualityWatch(env, { test: true }) : null;
  return { admin: true, qoff: !!p.off, sent: r ? r.sent : undefined };
}
async function telGc(env, n) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "tel" }], where: { fieldFilter: { field: { fieldPath: "ts" }, op: "LESS_THAN", value: { integerValue: String(Date.now() - 30 * 86400000) } } }, limit: n || 100 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => ({ delete: r.document.name }));
  if (rows.length) await fsCommit(token, rows);
  return rows.length;
}
async function opCallMissed(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const to = payload && payload.to;
  if (!segOk(String(to || ""))) throw new Error("bad call");
  if (!(await sharesContact(token, uid, to))) throw new Error("not a contact");
  const pr = await fsGet(token, "accounts/" + to + "/chatprefs/main");
  const blocked = pr && fstr(pr, "data") ? (JSON.parse(fstr(pr, "data")).blocked || []) : [];
  if (blocked.indexOf(uid) >= 0) return { sent: 0 };
  const name = memberIdFields(claims).name.stringValue || "سوا";
  const job = pushTo(token, [to], strData({ t: "missed", call: String((payload && payload.callId) || ""), from: uid, cid: dmId(uid, to), title: name,
    body: payload.type === "video" ? "📹 مكالمة فيديو فائتة" : "📞 مكالمة فائتة", ts: Date.now() }));
  if (ctx && ctx.waitUntil) { ctx.waitUntil(job); return { queued: true }; }
  return { sent: await job };
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
/* ---------- 31) رمز سوا وطلبات التواصل (C10) ----------
   لكلّ حسابٍ رمزٌ من ١٠ أرقام: ٩ عشوائيّة (أوّلها ١–٩ فلا يشبه رقم هاتفٍ سودانيّ يبدأ بـ0) + رقم تحقّق (Luhn)
   يكشف أيّ خطأٍ في رقمٍ واحد أو تبديل رقمين متجاورين.
   codes/{code} = { uid, ts } — فريدٌ بالإنشاء المشروط · accounts/{uid}: code, codeTs, findable, gname
   من يُدخل الرمز يرى الاسم وحده (لا بريد ولا هاتف) ويرسل «طلب تواصل»؛ لا مراسلة ولا اتّصال قبل القبول.
   accounts/{to}/creq/{from} = { name, text, ts, code } · accounts/{from}/creqout/{to} = { name, ts } */
function luhnDigit(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) { let d = Number(s[s.length - 1 - i]); if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return String((10 - (sum % 10)) % 10);
}
function codeDigits(x) {
  return String(x == null ? "" : x).replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/\D/g, "");
}
function codeValid(c) { return /^[1-9]\d{9}$/.test(c) && luhnDigit(c.slice(0, 9)) === c[9]; }
function newCode() {
  const a = new Uint32Array(3); crypto.getRandomValues(a);
  const s = String(1 + (a[0] % 9)) + String(a[1] % 10000).padStart(4, "0") + String(a[2] % 10000).padStart(4, "0");
  return s + luhnDigit(s);
}
function accFindable(acc) { const f = acc && acc.fields && acc.fields.findable; return !(f && f.booleanValue === false); }
async function ensureCode(token, uid, claims, force) {
  const acc = await fsGet(token, "accounts/" + uid).catch(() => null);
  const old = fstr(acc, "code");
  if (old && !force) return { code: old, findable: accFindable(acc) };
  const anon = !!(claims && claims.firebase && claims.firebase.sign_in_provider === "anonymous");
  const gname = !anon && claims && typeof claims.name === "string" ? claims.name.trim().slice(0, 60) : "";
  for (let i = 0; i < 6; i++) {
    const c = newCode(), now = Date.now();
    const fields = { code: { stringValue: c }, codeTs: { integerValue: String(now) } }, mask = ["code", "codeTs"];
    if (gname && !fstr(acc, "gname")) { fields.gname = { stringValue: gname }; mask.push("gname"); }
    const writes = [
      { update: { name: DOC_ROOT + "/codes/" + c, fields: { uid: { stringValue: uid }, ts: { integerValue: String(now) } } }, currentDocument: { exists: false } },
      { update: { name: DOC_ROOT + "/accounts/" + uid, fields }, updateMask: { fieldPaths: mask } },
    ];
    if (old) writes.push({ delete: DOC_ROOT + "/codes/" + old });
    try { await fsCommit(token, writes); }
    catch (e) { if (/ALREADY_EXISTS/.test(String(e && e.message))) continue; throw e; }
    const pc = PROFILE_CACHE.get(uid); if (pc) { pc.code = c; pc.findable = accFindable(acc); }
    return { code: c, findable: accFindable(acc) };
  }
  throw new Error("code generation failed");
}
// حدّ البحث والطلبات: ٣٠ بحثاً و١٠ طلبات في الساعة لكلّ مستخدم (يمنع تخمين الرموز وإغراق الناس بالطلبات)
const CODE_RL = new Map();
/* ---------- 49) معاينة الروابط (C49) ----------
   link.peek {url}: http(s) فقط · لا عناوين خاصّة/محلّيّة (حماية SSRF) · حدّ ١٠ ثوانٍ و٢٥٦ كيلوبايت · HTML فقط · ذاكرة ساعة · ٦٠/ساعة لكلّ مستخدم.
   الصورة لا تمرّ عبر الخادم: نعيد عنوانها فقط والجهاز يحمّلها. */
const LINK_CACHE = new Map();
function linkHostOk(h) {
  h = String(h || "").toLowerCase();
  if (!h || h === "localhost" || /\.(local|internal|localhost)$/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {   // IPv4 حرفيّ: نرفض الخاصّ والمحلّيّ
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224) return false;
  }
  if (h.indexOf(":") >= 0) return false;         // IPv6 حرفيّ
  return true;
}
function htmlDecode(t) { return String(t || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ""; } }).replace(/\s+/g, " ").trim(); }
function metaOf(html, names) {
  for (const n of names) {
    const re1 = new RegExp("<meta[^>]+(?:property|name)=[\"']" + n.replace(/:/g, "\\:") + "[\"'][^>]*content=[\"']([^\"']{1,600})[\"']", "i");
    const re2 = new RegExp("<meta[^>]+content=[\"']([^\"']{1,600})[\"'][^>]*(?:property|name)=[\"']" + n.replace(/:/g, "\\:") + "[\"']", "i");
    const m = html.match(re1) || html.match(re2); if (m) return htmlDecode(m[1]);
  }
  return "";
}
async function opLinkPeek(uid, payload, env) {
  if (!codeRate(uid, "link", 60)) throw new Error("rate_limited");
  let u; try { u = new URL(String((payload && payload.url) || "")); } catch (e) { throw new Error("bad url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad url");
  if (!linkHostOk(u.hostname)) throw new Error("bad url");
  u.hash = ""; const key = u.toString().slice(0, 1500);
  const c = LINK_CACHE.get(key); if (c && Date.now() - c.at < 3600000) return c.v;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
  let out = { ok: true, url: key, host: u.hostname.replace(/^www\./, ""), title: "", desc: "", image: "" };
  try {
    const res = await fetch(key, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; SawaLinkPreview/1; +https://www.sawaaap.com)", "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "ar,en;q=0.8" } });
    const ct = String(res.headers.get("content-type") || "");
    if (res.ok && /text\/html|application\/xhtml/i.test(ct)) {
      const reader = res.body.getReader(); const chunks = []; let got = 0;
      while (got < 262144) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
      try { reader.cancel(); } catch (e) {}
      const buf = new Uint8Array(got); let o = 0; for (const ch of chunks) { buf.set(ch.subarray(0, Math.min(ch.length, got - o)), o); o += ch.length; if (o >= got) break; }
      const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const tm2 = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
      out.title = metaOf(html, ["og:title", "twitter:title"]) || (tm2 ? htmlDecode(tm2[1]) : "");
      out.desc = metaOf(html, ["og:description", "twitter:description", "description"]).slice(0, 220);
      let img = metaOf(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
      if (img) { try { const iu = new URL(img, res.url || key); if ((iu.protocol === "https:" || iu.protocol === "http:") && linkHostOk(iu.hostname)) out.image = iu.toString().slice(0, 1000); } catch (e) {} }
      try { out.host = new URL(res.url || key).hostname.replace(/^www\./, ""); } catch (e) {}
    } else if (res.ok && /^image\//i.test(ct)) { out.image = key; }
  } catch (e) { out.err = "unreachable"; }
  clearTimeout(tm);
  out.title = String(out.title || "").slice(0, 160);
  LINK_CACHE.set(key, { at: Date.now(), v: out }); if (LINK_CACHE.size > 2000) LINK_CACHE.clear();
  stat("link:peek");
  return out;
}
function codeRate(uid, kind, max) {
  const k = uid + ":" + kind, now = Date.now(); let e = CODE_RL.get(k);
  if (!e || now - e.t > 3600000) { e = { t: now, n: 0 }; CODE_RL.set(k, e); }
  if (CODE_RL.size > 5000) { for (const [kk, v] of CODE_RL) if (now - v.t > 3600000) CODE_RL.delete(kk); }
  return ++e.n <= max;
}
async function codeTarget(token, raw) {
  const c = codeDigits(raw);
  if (!codeValid(c)) throw new Error("bad_code");
  const d = await fsGet(token, "codes/" + c);
  const t = fstr(d, "uid");
  if (!t) return null;
  const acc = await fsGet(token, "accounts/" + t);
  if (!acc || fstr(acc, "code") !== c || !accFindable(acc)) return null;   // رمزٌ قديم (غُيّر) أو صاحبه أخفى نفسه
  return { uid: t, code: c, name: fstr(acc, "displayName") || fstr(acc, "gname") || null };
}
async function myName(token, uid, claims) {
  const n = memberIdFields(claims).name.stringValue;
  if (n) return n;
  const acc = await fsGet(token, "accounts/" + uid).catch(() => null);
  return fstr(acc, "gname") || null;
}
async function opCodeMine(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  return await ensureCode(token, uid, claims, false);
}
async function opCodeFind(uid, payload, env) {
  if (!codeRate(uid, "find", 30)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = await codeTarget(token, payload && payload.code);
  if (!t) return { found: false };
  if (t.uid === uid) return { found: true, self: true, name: t.name, code: t.code };
  const [contact, outR, inR] = await Promise.all([sharesContact(token, uid, t.uid),
    fsGet(token, "accounts/" + uid + "/creqout/" + t.uid), fsGet(token, "accounts/" + uid + "/creq/" + t.uid)]);
  return { found: true, name: t.name, code: t.code, contact: !!contact, pending: inR ? "in" : outR ? "out" : null, uid: (contact || inR || outR) ? t.uid : undefined };
}
// C50: إشارةٌ في RTDB يراقبها جهاز المستلم (sig/$uid — يقرؤها صاحبها فقط) فيحدّث الطلبات وجهات الاتّصال فوراً ولو كانت الإشعارات مغلقة
async function sigTo(token, uids, kind) {
  const pat = {}; const now = Date.now();
  for (const u of [].concat(uids || [])) if (u) pat["sig/" + u] = { k: kind, ts: now };
  if (Object.keys(pat).length) await rtdbPatch(token, pat).catch(e => console.log("sig:", e && e.message));
}
async function opCodeRequest(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "req", 10)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const t = await codeTarget(token, payload && payload.code);
  if (!t) throw new Error("not_found");
  if (t.uid === uid) throw new Error("self");
  if (await sharesContact(token, uid, t.uid)) return { already: true, uid: t.uid };
  // طلبه إليّ قائم ⇒ قبولٌ متبادل فوراً
  if (await fsGet(token, "accounts/" + uid + "/creq/" + t.uid)) {
    const r = await acceptReq(token, uid, t.uid, claims, ctx);
    return Object.assign({ accepted: true, uid: t.uid }, r);
  }
  const outs = await fsList(token, "accounts/" + uid + "/creqout");
  if (outs.length >= 20 && !outs.some(d => d.name.split("/").pop() === t.uid)) throw new Error("too_many_pending");
  const me = await myName(token, uid, claims), now = Date.now();
  const text = String((payload && payload.text) || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const myCode = (await ensureCode(token, uid, claims, false)).code;
  const writes = [{ update: { name: DOC_ROOT + "/accounts/" + uid + "/creqout/" + t.uid, fields: {
    name: t.name ? { stringValue: t.name } : { nullValue: null }, code: { stringValue: t.code }, ts: { integerValue: String(now) } } } }];
  // من حظرني لا يصله شيء — ولا يعرف المرسل (يبقى «بانتظار الموافقة»)
  const blocked = await blockedBy(token, t.uid, uid).catch(() => false);
  if (!blocked) writes.push({ update: { name: DOC_ROOT + "/accounts/" + t.uid + "/creq/" + uid, fields: {
    name: me ? { stringValue: me } : { nullValue: null }, text: { stringValue: text }, code: { stringValue: myCode }, ts: { integerValue: String(now) } } } });
  await fsCommit(token, writes);
  if (!blocked) {
    const job = pushTo(token, [t.uid], strData({ t: "req", from: uid, title: "طلب تواصل في سوا", body: (me || "مستخدم سوا") + (text ? ": " + text : " يريد التواصل معك"), ts: now }))
      .catch(e => console.log("push:", e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    await sigTo(token, [t.uid], "req");
  }
  return { sent: true, name: t.name, uid: t.uid };   // v58: ليحفظ المرسل اسمه عنده (تسمية) قبل القبول
}
// ============================================================
//  v59: القصص (الاستوري) — لجهات اتّصالي، تختفي بعد ٢٤ ساعة
//  stories/{u} = { name, aud[] (جهات اتّصاله − المُخفى عنهم), hide[], items[] ≤ ٣٠ (نصّ/صورة/فيديو), exp (أقرب انتهاء), ts }
//  stories/{u}/media/{mid}{by,mime,size,n,ts,done} + c/{i}{d} — يرفعها صاحبها مباشرةً (القواعد)، ويقرؤها من في aud
//  stories/{u}/seen/{sid~viewer} = { sid, by, ts } — «شاهدها» يقرؤه صاحب القصّة وحده
// ============================================================
const STORY_TTL = 24 * 3600000, STORY_MAX = 30, STORY_BG = 8;
function storyItems(doc) {
  const v = doc && doc.fields && doc.fields.items;
  const arr = v && v.arrayValue && v.arrayValue.values ? v.arrayValue.values.map(fsToJs) : [];
  return arr.filter(x => x && x.id);
}
async function storyAud(token, uid, hide) {
  const acl = (await rtdbGet(token, "acl/" + uid).catch(() => null)) || {};
  const h = new Set(hide || []);
  return Object.keys(acl).filter(u => acl[u] === true && u !== uid && segOk(u) && !h.has(u)).slice(0, 2000);
}
function storyMinExp(items) { return items.length ? Math.min(...items.map(x => Number(x.exp) || 0)) : 0; }
async function storyWrite(token, uid, name, aud, hide, items) {
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/stories/" + uid, fields: {
    name: { stringValue: String(name || "").slice(0, 80) }, aud: toFsValue(aud), hide: toFsValue(hide || []), items: toFsValue(items),
    exp: { integerValue: String(storyMinExp(items)) }, ts: { integerValue: String(Date.now()) } } } }]);
}
async function storyDropMedia(token, owner, it) {
  if (!it || !it.mid || !/^[a-z0-9]{6,32}$/.test(String(it.mid))) return;
  const base = DOC_ROOT + "/stories/" + owner + "/media/" + it.mid, n = Math.min(40, Number(it.n) || 33);
  const w = [{ delete: base }]; for (let i = 0; i < n; i++) w.push({ delete: base + "/c/" + i });
  await fsCommit(token, w).catch(() => {});
}
// v61: حجز رفع وسيط القصّة (كالمحادثات): حدٌّ يوميّ مشترك، والقواعد ترفض وسيطاً بلا حجز أو أكبر منه، وما بقي ٤٨ ساعة يُحذف
async function opStoryBegin(uid, payload, env) {
  if (!codeRate(uid, "storyb", 40)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const mid = String((payload || {}).mid || ""), size = Math.floor(Number((payload || {}).size) || 0);
  if (!/^[a-z0-9]{6,32}$/.test(mid)) throw new Error("bad media id");
  if (!(size > 0 && size <= 16 * 1024 * 1024)) throw new Error("bad size");
  const day = dayKey(Date.now()), q = await fsGet(token, "quota/" + uid).catch(() => null);
  const used = q && fstr(q, "d") === day ? fsInt(q, "bytes") : 0;
  if (used + size > MEDIA_DAY_MAX) throw new Error("media quota");
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/storyq/" + uid + "~" + mid, fields: { uid: { stringValue: uid }, mid: { stringValue: mid }, size: { integerValue: String(size) }, ts: { integerValue: String(Date.now()) } } } },
    { update: { name: DOC_ROOT + "/quota/" + uid, fields: { d: { stringValue: day }, bytes: { integerValue: String(used + size) } } } },
  ]);
  return { ok: true };
}
async function storyqGc(env, max) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "storyq" }], where: { fieldFilter: { field: { fieldPath: "ts" }, op: "LESS_THAN", value: { integerValue: String(Date.now() - 2 * 86400000) } } }, limit: max || 5 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let n = 0;
  for (const d of rows) {
    const u = fstr(d, "uid"), mid = fstr(d, "mid");
    try { if (segOk(u)) await storyDropMedia(token, u, { mid, n: 40 }); await fsCommit(token, [{ delete: d.name }]); n++; } catch (e) { console.log("storyqGc:", e && e.message); }
  }
  return { gc: n };
}
async function opStoryPost(uid, payload, env, claims) {
  if (!codeRate(uid, "story", 30)) throw new Error("rate_limited");
  const p = payload || {}, t = String(p.t || "");
  if (["text", "image", "video"].indexOf(t) < 0) throw new Error("bad type");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const now = Date.now();
  const item = { id: "s" + now.toString(36) + Math.random().toString(36).slice(2, 6), t, ts: now, exp: now + STORY_TTL,
    text: String(p.text || "").replace(/\r/g, "").slice(0, 700), bg: Math.max(0, Math.min(STORY_BG - 1, Number(p.bg) || 0)) };
  if (t === "text" && !item.text.trim()) throw new Error("empty");
  if (t !== "text") {
    const mid = String(p.mid || "");
    if (!/^[a-z0-9]{6,32}$/.test(mid)) throw new Error("bad id: mid");
    const md = await fsGet(token, "stories/" + uid + "/media/" + mid);
    if (!md || fstr(md, "by") !== uid || !fbool(md, "done")) throw new Error("media not uploaded");
    Object.assign(item, { mid, mime: fstr(md, "mime").slice(0, 100), size: fsInt(md, "size"), n: fsInt(md, "n") });
    if (p.thumb && typeof p.thumb === "string" && p.thumb.length <= 8000 && /^data:image\/(jpeg|png|webp);base64,/.test(p.thumb)) item.thumb = p.thumb;
    if (Number(p.w) > 0 && Number(p.h) > 0) { item.w = Math.round(Number(p.w)); item.h = Math.round(Number(p.h)); }
    if (t === "video") item.dur = Math.max(1, Math.min(31, Math.round(Number(p.dur) || 15)));
  }
  const doc = await fsGet(token, "stories/" + uid).catch(() => null);
  const hide = fsArr(doc, "hide");
  const items = storyItems(doc).filter(x => Number(x.exp) > now);
  if (items.length >= STORY_MAX) throw new Error("too_many");
  items.push(item);
  const [aud, name] = await Promise.all([storyAud(token, uid, hide), myName(token, uid, claims)]);
  await storyWrite(token, uid, name, aud, hide, items);
  stat("story:post");
  return { item, aud: aud.length };
}
async function opStoryDelete(uid, payload, env, claims) {
  const sid = String((payload && payload.sid) || "");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await fsGet(token, "stories/" + uid);
  if (!doc) return { deleted: false };
  const all = storyItems(doc), it = all.find(x => x.id === sid);
  if (!it) return { deleted: false };
  await storyDropMedia(token, uid, it);
  const items = all.filter(x => x.id !== sid && Number(x.exp) > Date.now());
  await storyWrite(token, uid, fstr(doc, "name"), fsArr(doc, "aud"), fsArr(doc, "hide"), items);
  return { deleted: true };
}
async function opStoryView(uid, payload, env) {
  const owner = String((payload && payload.owner) || ""), sid = String((payload && payload.sid) || "");
  if (!segOk(owner) || !/^s[a-z0-9]{4,20}$/.test(sid)) throw new Error("bad id");
  if (owner === uid) return { ok: true };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await fsGet(token, "stories/" + owner);
  if (!doc || fsArr(doc, "aud").indexOf(uid) < 0 || !storyItems(doc).some(x => x.id === sid)) return { ok: false };
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/stories/" + owner + "/seen/" + sid + "~" + uid, fields: {
    sid: { stringValue: sid }, by: { stringValue: uid }, ts: { integerValue: String(Date.now()) } } } }]);
  return { ok: true };
}
// المُخفى عنهم قصصي (والجمهور يُعاد حسابه من جهات الاتّصال الحاليّة)
async function opStoryAudience(uid, payload, env, claims) {
  const hide = [...new Set((Array.isArray(payload && payload.hide) ? payload.hide : []).map(String).filter(segOk))].slice(0, 2000);
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await fsGet(token, "stories/" + uid).catch(() => null);
  const items = storyItems(doc).filter(x => Number(x.exp) > Date.now());
  const [aud, name] = await Promise.all([storyAud(token, uid, hide), myName(token, uid, claims)]);
  await storyWrite(token, uid, name, aud, hide, items);
  return { aud: aud.length, hide };
}
// ============================================================
//  C133: لحظات الأصدقاء — منشوراتٌ دائمة (نصّ · حتّى ٤ صور أو فيديو ≤ ٣٠ ث · موقع · استطلاع) · إعجاب وتعليقات · جمهورٌ لكلّ لحظة
//  moments/{pid} = { by, name, aud[] (يشمل صاحبها), mode, text, media[], loc, poll{q,opts[]}, votes{uid:idx}, likes[], cc, ts }
//    pid = "m" + (9e12 − الوقت) بأساس ٣٦ (٩ خانات) + ٤ عشوائيّة ⇒ ترتيب المعرّفات تصاعديّاً = الأحدث أوّلاً ⇒ الخلاصة بلا فهرسٍ مركّب
//  moments/{pid}/media/{mid} + c/{i} — يرفعها صاحبها مباشرةً بعد حجز moment.begin (momentq/{pid~mid}) · يقرؤها من في aud
//  moments/{pid}/cm/{cmid} = { by, name, text, ts } — يكتبها الخادم · يقرؤها من في aud
//  mset/{uid} = { close[], hide[] } — المقرّبون والمُخفى عنهم افتراضيّاً
// ============================================================
const MOM_TEXT = 2000, MOM_MEDIA = 4, MOM_CMT = 500;
function momPidOk(p) { return typeof p === "string" && /^m[0-9a-z]{9}[0-9a-z]{4}$/.test(p); }
function momMidOk(m) { return typeof m === "string" && /^[a-z0-9]{6,32}$/.test(m); }
function momMap(doc, k) { const v = doc && doc.fields && doc.fields[k]; return v ? fsToJs(v) : null; }
async function momGet(token, pid) { const d = await fsGet(token, "moments/" + pid).catch(() => null); return d && d.fields ? d : null; }
function momCanSee(doc, uid) { return !!doc && fsArr(doc, "aud").indexOf(uid) >= 0; }
async function momPrefs(token, uid) {
  const d = await fsGet(token, "mset/" + uid).catch(() => null);
  return { close: fsArr(d, "close"), hide: fsArr(d, "hide"), mute: fsArr(d, "mute"), seen: fsInt(d, "seen"), np: fsInt(d, "np") };
}
// C133b: إزالة أشخاصٍ من جمهور كلّ لحظاتي السابقة (حين أُخفي عنهم لحظاتي أو أحظرهم) — الجمهور يُحسب عند النشر فيجب تنظيفه بعده
async function momStrip(token, uid, uids) {
  uids = (uids || []).filter(u => segOk(String(u)) && u !== uid);
  if (!uids.length) return 0;
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "moments" }], where: { fieldFilter: { field: { fieldPath: "by" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 300 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  const hit = rows.filter(d => fsArr(d, "aud").some(u => uids.indexOf(u) >= 0));
  for (let i = 0; i < hit.length; i += 100) {
    await fsCommit(token, hit.slice(i, i + 100).map(d => ({ update: { name: d.name }, updateMask: { fieldPaths: [] },
      updateTransforms: [{ fieldPath: "aud", removeAllFromArray: { values: uids.map(u => ({ stringValue: u })) } }] }))).catch(e => console.log("momStrip:", e && e.message));
  }
  return hit.length;
}
async function opMomentPrefs(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const p = payload || {}, cur = await momPrefs(token, uid);
  const clean = (a) => [...new Set((Array.isArray(a) ? a : []).map(String).filter(u => segOk(u) && u !== uid))].slice(0, 1000);
  if (!Array.isArray(p.close) && !Array.isArray(p.hide) && !Array.isArray(p.mute)) return cur;
  const next = { seen: cur.seen, close: Array.isArray(p.close) ? clean(p.close) : cur.close, hide: Array.isArray(p.hide) ? clean(p.hide) : cur.hide, mute: Array.isArray(p.mute) ? clean(p.mute) : cur.mute };
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/mset/" + uid, fields: { close: toFsValue(next.close), hide: toFsValue(next.hide), mute: toFsValue(next.mute), ts: { integerValue: String(Date.now()) } } }, updateMask: { fieldPaths: ["close", "hide", "mute", "ts"] } }]);   // C135: يبقى seen
  // «لا تُظهر لحظاتي لـ» يشمل اللحظات السابقة أيضاً
  const added = next.hide.filter(u => cur.hide.indexOf(u) < 0);
  if (added.length) next.stripped = await momStrip(token, uid, added).catch(() => 0);
  return next;
}
async function opMomentBegin(uid, payload, env) {
  if (!codeRate(uid, "momb", 60)) throw new Error("rate_limited");
  const p = payload || {}, pid = String(p.pid || ""), mid = String(p.mid || ""), size = Math.floor(Number(p.size) || 0);
  if (!momPidOk(pid) || !momMidOk(mid)) throw new Error("bad id");
  if (!(size > 0 && size <= 16 * 1024 * 1024)) throw new Error("bad size");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const ex = await momGet(token, pid);
  if (ex) throw new Error("exists");
  const day = dayKey(Date.now()), q = await fsGet(token, "quota/" + uid).catch(() => null);
  const used = q && fstr(q, "d") === day ? fsInt(q, "bytes") : 0;
  if (used + size > MEDIA_DAY_MAX) throw new Error("media quota");
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/momentq/" + pid + "~" + mid, fields: { uid: { stringValue: uid }, pid: { stringValue: pid }, mid: { stringValue: mid }, size: { integerValue: String(size) }, ts: { integerValue: String(Date.now()) } } } },
    { update: { name: DOC_ROOT + "/quota/" + uid, fields: { d: { stringValue: day }, bytes: { integerValue: String(used + size) } } } },
  ]);
  return { ok: true };
}
async function momAudience(token, uid, a, hideExtra) {
  const mode = a && typeof a === "object" ? String(a.mode || "contacts") : "contacts";
  const contacts = await contactSet(token, uid);
  const prefs = await momPrefs(token, uid);
  let list = [], label = "contacts";
  if (mode === "close") { list = prefs.close.filter(u => u in contacts); label = "close"; }
  else if (mode === "chat") {
    const cid = String(a.cid || "");
    if (!segOk(cid)) throw new Error("bad cid");
    const c = await requireChatMember(token, cid, uid);
    const t = fstr(c, "type");
    if (t !== "group" && t !== "family") throw new Error("bad chat");
    list = fsArr(c, "members"); label = "chat:" + (fstr(c, "name") || "").slice(0, 60);
  } else if (mode === "custom") {
    list = (Array.isArray(a.uids) ? a.uids : []).map(String).filter(u => segOk(u) && (u in contacts)); label = String(a.label || "custom").slice(0, 60) || "custom";
  } else { list = Object.keys(contacts); label = "contacts"; }
  const hide = new Set(prefs.hide.concat(Array.isArray(hideExtra) ? hideExtra.map(String) : []));
  list = [...new Set(list)].filter(u => u !== uid && segOk(u) && !hide.has(u)).slice(0, 1500);
  // الحظر بالاتّجاهين: من حظرني (blk/{هو}/{أنا}) ومن حظرتُه (blk/{أنا})
  const mine = (await rtdbGet(token, "blk/" + uid).catch(() => null)) || {};
  list = list.filter(u => mine[u] !== true);
  const blk = list.length ? await blockedSet(token, list, uid) : new Set();
  list = list.filter(u => !blk.has(u));
  return { aud: [uid].concat(list), label, n: list.length, prefs };
}
async function opMomentPost(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "mom", 30)) throw new Error("rate_limited");
  const p = payload || {}, pid = String(p.pid || "");
  if (!momPidOk(pid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  if (await momGet(token, pid)) throw new Error("exists");
  const text = String(p.text || "").replace(/\r/g, "").slice(0, MOM_TEXT);
  const media = [];
  const inMedia = Array.isArray(p.media) ? p.media.slice(0, MOM_MEDIA) : [];
  for (const m of inMedia) {
    const mid = String((m && m.mid) || ""), t = m && m.t === "video" ? "video" : "image";
    if (!momMidOk(mid)) throw new Error("bad id: mid");
    const md = await fsGet(token, "moments/" + pid + "/media/" + mid).catch(() => null);
    if (!md || fstr(md, "by") !== uid || !fbool(md, "done")) throw new Error("media not uploaded");
    const it = { mid, t, mime: fstr(md, "mime").slice(0, 100), size: fsInt(md, "size"), n: fsInt(md, "n") };
    if (m.thumb && typeof m.thumb === "string" && m.thumb.length <= 8000 && /^data:image\/(jpeg|png|webp);base64,/.test(m.thumb)) it.thumb = m.thumb;
    // C137: غلاف الفيديو الواضح (≤ ١٢٠ ألف حرف ≈ ٩٠ كيلوبايت) — فيديو واحد في اللحظة فيبقى المستند صغيراً
    if (t === "video" && m.poster && typeof m.poster === "string" && m.poster.length <= 120000 && /^data:image\/jpeg;base64,/.test(m.poster)) it.poster = m.poster;
    if (Number(m.w) > 0 && Number(m.h) > 0) { it.w = Math.round(Number(m.w)); it.h = Math.round(Number(m.h)); }
    if (t === "video") it.dur = Math.max(1, Math.min(31, Math.round(Number(m.dur) || 15)));
    media.push(it);
  }
  if (media.filter(x => x.t === "video").length > 1 || (media.some(x => x.t === "video") && media.length > 1)) throw new Error("one video only");
  let loc = null;
  if (p.loc && isFinite(Number(p.loc.lat)) && isFinite(Number(p.loc.lng)) && Math.abs(Number(p.loc.lat)) <= 90 && Math.abs(Number(p.loc.lng)) <= 180)
    loc = { lat: Math.round(Number(p.loc.lat) * 1e5) / 1e5, lng: Math.round(Number(p.loc.lng) * 1e5) / 1e5, label: String(p.loc.label || "").slice(0, 80) };
  let poll = null;
  if (p.poll && typeof p.poll === "object") {
    const opts = (Array.isArray(p.poll.opts) ? p.poll.opts : []).map(x => String(x || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 4);
    const q = String(p.poll.q || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (opts.length >= 2) poll = { q, opts };
  }
  if (!text.trim() && !media.length && !poll && !loc) throw new Error("empty");
  const [au, name] = await Promise.all([momAudience(token, uid, p.aud, p.hide), myName(token, uid, claims)]);
  const now = Date.now();
  const { men, menN } = momMen(p.men, au.aud, uid);   // C135
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/moments/" + pid, fields: {
    by: { stringValue: uid }, name: { stringValue: String(name || "").slice(0, 80) }, aud: toFsValue(au.aud), mode: { stringValue: au.label },
    text: { stringValue: text }, media: toFsValue(media), loc: loc ? toFsValue(loc) : { nullValue: null }, poll: poll ? toFsValue(poll) : { nullValue: null },
    votes: { mapValue: { fields: {} } }, likes: { arrayValue: { values: [] } }, cc: { integerValue: "0" }, ts: { integerValue: String(now) },
    men: toFsValue(men), menN: toFsValue(menN) } },
    currentDocument: { exists: false } }]);
  const del = media.map(m => ({ delete: DOC_ROOT + "/momentq/" + pid + "~" + m.mid }));
  if (del.length) await fsCommit(token, del).catch(() => {});
  stat("moment:post");
  if (men.length) {
    const rcp = {}; men.forEach(u => { rcp[u] = "mention"; });
    const fake = { name: DOC_ROOT + "/moments/" + pid, fields: { aud: toFsValue(au.aud), text: { stringValue: text }, by: { stringValue: uid } } };
    await momNotes(token, env, ctx, fake, uid, claims, rcp, { text: text || "📷" }).catch(e => console.log("mention:", e && e.message));
  }
  // C153: «لحظة جديدة» لمن في الجمهور (كإشعار القصص في انستجرام)
  const np = momNewPush(token, env, uid, pid, String(name || "مستخدم سوا").slice(0, 80), au, men, media).catch(e => console.log("newpush:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(np); else await np;
  return { pid, aud: au.n, mode: au.label, men: men.length };
}
/* C153: إشعار «لحظة جديدة» — العنوان اسم الناشر (وصورته) والنصّ «لحظة جديدة 📷».
   مرّةً كلّ ٤ ساعات على الأكثر لكلّ ناشر (mset/{uid}.np) · حتّى ١٠ مستلمين (حدّ الطلبات الفرعيّة): المقرّبون أوّلاً ثمّ عشوائيّاً ·
   يُستثنى من أُشير إليه (وصله إشعار الإشارة) ومن كتم لحظاتي (mset/{هو}.mute) · أوّل لحظة بعد ١٤ يوماً ⇒ «أوّل لحظة منذ فترة طويلة». */
const MOM_NEW_GAP = 4 * 3600000, MOM_NEW_MAX = 60;   // C180: كان ١٠ (حدّ الخطّة المجّانيّة)
async function momNewPush(token, env, uid, pid, me, au, men, media) {
  const now = Date.now(), last = (au.prefs && au.prefs.np) || 0;
  if (last && now - last < MOM_NEW_GAP) return 0;
  let to = au.aud.filter(u => u !== uid && men.indexOf(u) < 0);
  if (!to.length) return 0;
  const close = new Set((au.prefs && au.prefs.close) || []);
  const rest = to.filter(u => !close.has(u));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
  to = to.filter(u => close.has(u)).concat(rest).slice(0, MOM_NEW_MAX * 2);
  try {   // من كتم لحظاتي لا يصله شيء
    const res = await fetch(FS_BASE + ":batchGet", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: to.map(u => DOC_ROOT + "/mset/" + u), mask: { fieldPaths: ["mute"] } }) });
    const muted = new Set();
    for (const r of (await res.json()) || []) if (r.found && fsArr(r.found, "mute").indexOf(uid) >= 0) muted.add(r.found.name.split("/").pop());
    to = to.filter(u => !muted.has(u));
  } catch (e) { }
  to = to.slice(0, MOM_NEW_MAX);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/mset/" + uid, fields: { np: { integerValue: String(now) } } }, updateMask: { fieldPaths: ["np"] } }]).catch(() => {});
  if (!to.length) return 0;
  const icon = media.some(m => m.t === "video") ? " 🎥" : media.length ? " 📷" : "";
  const body = (last && now - last > 14 * 86400000 ? "أوّل لحظة منذ فترة طويلة" : "لحظة جديدة") + icon;
  const d = strData({ t: "moment", k: "new", pid, from: uid, ak: await ackSig(env, "av|" + uid), title: me, body, ts: now });
  stat("moment:newpush");
  return pushTo(token, to, d);
}
async function momDropMedia(token, pid, it) {
  if (!it || !momMidOk(String(it.mid || ""))) return;
  const base = DOC_ROOT + "/moments/" + pid + "/media/" + it.mid, n = Math.min(40, Number(it.n) || 33);
  const w = [{ delete: base }]; for (let i = 0; i < n; i++) w.push({ delete: base + "/c/" + i });
  await fsCommit(token, w).catch(() => {});
}
async function opMomentDelete(uid, payload, env, claims) {
  const pid = String((payload && payload.pid) || "");
  if (!momPidOk(pid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!doc) return { deleted: false };
  if (fstr(doc, "by") !== uid && !isAdmin(env, claims)) throw new Error("not yours");
  for (const it of (momMap(doc, "media") || [])) await momDropMedia(token, pid, it);
  const cms = await fsList(token, "moments/" + pid + "/cm").catch(() => []);
  for (let i = 0; i < cms.length; i += 100) await fsCommit(token, cms.slice(i, i + 100).map(d => ({ delete: d.name }))).catch(() => {});
  await fsCommit(token, [{ delete: DOC_ROOT + "/moments/" + pid }]);
  return { deleted: true };
}
// C135: الإشعارات داخل التطبيق (mnote/{uid}/n/{nid}) + إشعار الهاتف — لصاحب اللحظة · لصاحب التعليق المردود عليه · لمن ذُكروا بـ@
//   nid = "n" + (9e12 − الوقت) بأساس ٣٦ ⇒ ترتيب المعرّفات = الأحدث أوّلاً (بلا فهرس) · k: like | comment | reply | mention | mentionc | creact
const MOM_RX = ["❤️", "😍", "😂", "😊", "😮", "😢", "😭", "😡", "👏", "🤲"];   // C136
function momRid() { let n = (9e12 - Date.now()).toString(36); while (n.length < 9) n = "0" + n; return n.slice(-9) + Math.random().toString(36).slice(2, 6).padEnd(4, "0"); }
function momCmidOk(c) { return typeof c === "string" && /^c[0-9a-z]{6,20}$/.test(c); }
// الإشارات: [{u, n}] أو معرّفات ⇒ من في جمهور اللحظة فقط (لا يُشار إلى من لا يراها) · ≤ ٢٠
function momMen(raw, aud, uid) {
  const out = [], names = {};
  for (const x of (Array.isArray(raw) ? raw : []).slice(0, 40)) {
    const u = String(x && typeof x === "object" ? x.u : x || ""), n = x && typeof x === "object" ? String(x.n || "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (!segOk(u) || u === uid || aud.indexOf(u) < 0 || out.indexOf(u) >= 0) continue;
    out.push(u); if (n) names[u] = n;
    if (out.length >= 20) break;
  }
  return { men: out, menN: names };
}
const MOM_NOTE_ACT = { comment: "علّق على لحظتك", reply: "ردّ على تعليقك", mention: "أشار إليك في لحظة", mentionc: "أشار إليك في تعليق", creact: "أعجبه تعليقك", like: "أعجبته لحظتك" };   // C152
const MOM_NOTE_TXT = {
  like: (me) => me + " أعجبته لحظتك", comment: (me) => me + " علّق على لحظتك", reply: (me) => me + " ردّ على تعليقك",
  mention: (me) => me + " أشار إليك في لحظة", mentionc: (me) => me + " أشار إليك في تعليق", creact: (me) => me + " أعجبه تعليقك",
};
// rcp: { uid: kind } — يُستبعد الفاعل ومن ليس في الجمهور ومن بيني وبينه حظر · الإعجاب بالتعليق: داخل التطبيق فقط (بلا إشعار هاتف)
async function momNotes(token, env, ctx, doc, uid, claims, rcp, extra) {
  const aud = fsArr(doc, "aud"), pid = doc.name.split("/").pop();
  let to = Object.keys(rcp || {}).filter(u => u && u !== uid && aud.indexOf(u) >= 0);
  if (!to.length) return 0;
  const mine = (await rtdbGet(token, "blk/" + uid).catch(() => null)) || {};
  to = to.filter(u => mine[u] !== true);
  const blk = to.length ? await blockedSet(token, to, uid) : new Set();
  to = to.filter(u => !blk.has(u));
  if (!to.length) return 0;
  const me = String((await myName(token, uid, claims)) || "مستخدم سوا").slice(0, 80), now = Date.now();
  const snip = String((extra && extra.text) || fstr(doc, "text") || "").replace(/\s+/g, " ").slice(0, 140);
  const writes = to.map(u => {
    const f = { k: { stringValue: rcp[u] }, pid: { stringValue: pid }, from: { stringValue: uid }, name: { stringValue: me }, text: { stringValue: snip }, ts: { integerValue: String(now) } };
    if (extra && extra.cm) f.cm = { stringValue: extra.cm };
    if (extra && extra.e) f.e = { stringValue: extra.e };
    return { update: { name: DOC_ROOT + "/mnote/" + u + "/n/n" + momRid(), fields: f } };
  });
  await fsCommit(token, writes).catch(e => console.log("mnote:", e && e.message));
  const ak = await ackSig(env, "av|" + uid);
  const jobs = to.filter(u => rcp[u] !== "creact").map(u => {
    // C152: كإشعارات انستجرام — العنوان اسم الفاعل (وصورته بجانبه) والنصّ ما فعله
    const k = rcp[u], title = me, e = (extra && extra.e) || "❤️";
    const body = k === "like" ? e + (e === "❤️" ? " أعجبته لحظتك" : " تفاعل مع لحظتك") + (snip ? " · " + snip.slice(0, 70) : "") : MOM_NOTE_ACT[k] + (snip ? ": " + snip.slice(0, 110) : "");
    const d = { t: "moment", pid, from: uid, ak, k, title, body, ts: now }; if (extra && extra.cm) d.cm = extra.cm;
    return pushTo(token, [u], strData(d)).catch(e => console.log("push:", e && e.message));
  });
  const job = Promise.all(jobs);
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return to.length;
}
async function opMomentLike(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "moml", 300)) throw new Error("rate_limited");
  const pid = String((payload && payload.pid) || ""), on = !!(payload && payload.on);
  const e = MOM_RX.indexOf(String((payload && payload.e) || "")) >= 0 ? String(payload.e) : "❤️";
  if (!momPidOk(pid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!momCanSee(doc, uid)) throw new Error("not found");
  const had = fsArr(doc, "likes").indexOf(uid) >= 0, rx = momMap(doc, "rx") || {};
  if (had === on && (!on || rx[uid] === e)) return { on, e };
  const w = { update: { name: DOC_ROOT + "/moments/" + pid, fields: on ? { rx: { mapValue: { fields: { [uid]: { stringValue: e } } } } } : {} },
    updateMask: { fieldPaths: [fp("rx", uid)] }, currentDocument: { exists: true } };
  if (had !== on) w.updateTransforms = [{ fieldPath: "likes", [on ? "appendMissingElements" : "removeAllFromArray"]: { values: [{ stringValue: uid }] } }];
  await fsCommit(token, [w]);
  if (on && !had) await momNotes(token, env, ctx, doc, uid, claims, { [fstr(doc, "by")]: "like" }, { e });
  return { on, e };
}
async function opMomentComment(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "momc", 120)) throw new Error("rate_limited");
  const p = payload || {}, pid = String(p.pid || ""), text = String(p.text || "").replace(/\r/g, "").trim().slice(0, MOM_CMT);
  if (!momPidOk(pid)) throw new Error("bad id");
  if (!text) throw new Error("empty");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!momCanSee(doc, uid)) throw new Error("not found");
  // الردّ: سلسلةٌ بمستوى واحد — الردّ على ردٍّ يُعلَّق تحت التعليق الأصل ويُبلَّغ صاحب الردّ
  let re = null, reBy = null, reName = "";
  if (p.re) {
    const r0 = String(p.re);
    if (!momCmidOk(r0)) throw new Error("bad id: re");
    const pc = await fsGet(token, "moments/" + pid + "/cm/" + r0).catch(() => null);
    if (!pc || !pc.fields) throw new Error("comment gone");
    re = fstr(pc, "re") || r0; reBy = fstr(pc, "by"); reName = fstr(pc, "name");
  }
  const { men, menN } = momMen(p.men, fsArr(doc, "aud"), uid);
  const now = Date.now(), cmid = "c" + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const name = String((await myName(token, uid, claims)) || "").slice(0, 80);
  const f = { by: { stringValue: uid }, name: { stringValue: name }, text: { stringValue: text }, ts: { integerValue: String(now) }, likes: { arrayValue: { values: [] } } };
  if (re) { f.re = { stringValue: re }; f.reBy = { stringValue: reBy || "" }; f.reName = { stringValue: String(reName || "").slice(0, 80) }; }
  if (men.length) { f.men = toFsValue(men); f.menN = toFsValue(menN); }
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/moments/" + pid + "/cm/" + cmid, fields: f } },
    { update: { name: DOC_ROOT + "/moments/" + pid, fields: { lastC: toFsValue({ id: cmid, by: uid, name, text: text.slice(0, 160), ts: now }) } }, updateMask: { fieldPaths: ["lastC"] },
      updateTransforms: [{ fieldPath: "cc", increment: { integerValue: "1" } }], currentDocument: { exists: true } },
  ]);
  const rcp = {}; rcp[fstr(doc, "by")] = "comment";
  if (reBy) rcp[reBy] = "reply";
  men.forEach(u => { rcp[u] = "mentionc"; });
  await momNotes(token, env, ctx, doc, uid, claims, rcp, { text, cm: cmid });
  return { cmid, ts: now, re };
}
async function momLastC(token, pid) {
  const cms = await fsList(token, "moments/" + pid + "/cm").catch(() => []);
  let best = null;
  for (const d of cms) { const ts = fsInt(d, "ts"); if (!best || ts > best.ts) best = { id: d.name.split("/").pop(), by: fstr(d, "by"), name: fstr(d, "name"), text: fstr(d, "text").slice(0, 160), ts }; }
  return { best, n: cms.length };
}
async function opMomentUncomment(uid, payload, env, claims) {
  const pid = String((payload && payload.pid) || ""), cmid = String((payload && payload.cmid) || "");
  if (!momPidOk(pid) || !momCmidOk(cmid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  const cm = await fsGet(token, "moments/" + pid + "/cm/" + cmid).catch(() => null);
  if (!doc || !cm || !cm.fields) return { deleted: false };
  if (fstr(cm, "by") !== uid && fstr(doc, "by") !== uid && !isAdmin(env, claims)) throw new Error("not yours");
  // حذف تعليقٍ أصل يحذف ردوده معه
  const del = [cm.name];
  if (!fstr(cm, "re")) {
    const all = await fsList(token, "moments/" + pid + "/cm").catch(() => []);
    all.forEach(d => { if (fstr(d, "re") === cmid) del.push(d.name); });
  }
  for (let i = 0; i < del.length; i += 100) await fsCommit(token, del.slice(i, i + 100).map(n => ({ delete: n })));
  const { best, n } = await momLastC(token, pid);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/moments/" + pid, fields: { cc: { integerValue: String(n) }, lastC: best ? toFsValue(best) : { nullValue: null } } },
    updateMask: { fieldPaths: ["cc", "lastC"] }, currentDocument: { exists: true } }]).catch(() => {});
  return { deleted: true, n: del.length };
}
// الإعجاب بتعليق (يراه صاحبه في إشعارات اللحظات — بلا إشعار هاتف)
async function opMomentCReact(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "momr", 300)) throw new Error("rate_limited");
  const pid = String((payload && payload.pid) || ""), cmid = String((payload && payload.cmid) || ""), on = !!(payload && payload.on);
  const e = MOM_RX.indexOf(String((payload && payload.e) || "")) >= 0 ? String(payload.e) : "❤️";   // C136: تفاعلٌ على التعليق
  if (!momPidOk(pid) || !momCmidOk(cmid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!momCanSee(doc, uid)) throw new Error("not found");
  const cm = await fsGet(token, "moments/" + pid + "/cm/" + cmid).catch(() => null);
  if (!cm || !cm.fields) throw new Error("comment gone");
  const had = fsArr(cm, "likes").indexOf(uid) >= 0, rx = momMap(cm, "rx") || {};
  if (had === on && (!on || rx[uid] === e)) return { on, e };
  const w = { update: { name: cm.name, fields: on ? { rx: { mapValue: { fields: { [uid]: { stringValue: e } } } } } : {} },
    updateMask: { fieldPaths: [fp("rx", uid)] }, currentDocument: { exists: true } };
  if (had !== on) w.updateTransforms = [{ fieldPath: "likes", [on ? "appendMissingElements" : "removeAllFromArray"]: { values: [{ stringValue: uid }] } }];
  await fsCommit(token, [w]);
  if (on && !had) await momNotes(token, env, ctx, doc, uid, claims, { [fstr(cm, "by")]: "creact" }, { text: fstr(cm, "text"), cm: cmid, e });
  return { on, e };
}
// C136: تعديل تعليقي أو ردّي (والإشارات) — يُبلَّغ من أُضيفت الإشارة إليه فقط
async function opMomentCEdit(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "momce", 60)) throw new Error("rate_limited");
  const p = payload || {}, pid = String(p.pid || ""), cmid = String(p.cmid || "");
  if (!momPidOk(pid) || !momCmidOk(cmid)) throw new Error("bad id");
  const text = String(p.text || "").replace(/\r/g, "").trim().slice(0, MOM_CMT);
  if (!text) throw new Error("empty");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!momCanSee(doc, uid)) throw new Error("not found");
  const cm = await fsGet(token, "moments/" + pid + "/cm/" + cmid).catch(() => null);
  if (!cm || !cm.fields) throw new Error("comment gone");
  if (fstr(cm, "by") !== uid) throw new Error("not yours");
  const { men, menN } = momMen(p.men, fsArr(doc, "aud"), uid);
  const old = fsArr(cm, "men"), now = Date.now();
  const w = [{ update: { name: cm.name, fields: { text: { stringValue: text }, men: toFsValue(men), menN: toFsValue(menN), edited: { integerValue: String(now) } } },
    updateMask: { fieldPaths: ["text", "men", "menN", "edited"] }, currentDocument: { exists: true } }];
  const lc = momMap(doc, "lastC");
  if (lc && lc.id === cmid) w.push({ update: { name: doc.name, fields: { lastC: toFsValue(Object.assign({}, lc, { text: text.slice(0, 160) })) } }, updateMask: { fieldPaths: ["lastC"] }, currentDocument: { exists: true } });
  await fsCommit(token, w);
  const rcp = {}; men.filter(u => old.indexOf(u) < 0).forEach(u => { rcp[u] = "mentionc"; });
  if (Object.keys(rcp).length) await momNotes(token, env, ctx, doc, uid, claims, rcp, { text, cm: cmid });
  return { edited: now };
}
// تعديل نصّ لحظتي (والإشارات) — يُبلَّغ من أُضيفت الإشارة إليه فقط
async function opMomentEdit(uid, payload, env, claims, ctx) {
  if (!codeRate(uid, "mome", 60)) throw new Error("rate_limited");
  const p = payload || {}, pid = String(p.pid || "");
  if (!momPidOk(pid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!doc) throw new Error("not found");
  if (fstr(doc, "by") !== uid) throw new Error("not yours");
  const text = String(p.text || "").replace(/\r/g, "").slice(0, MOM_TEXT);
  if (!text.trim() && !(momMap(doc, "media") || []).length && !momMap(doc, "poll") && !momMap(doc, "loc")) throw new Error("empty");
  const { men, menN } = momMen(p.men, fsArr(doc, "aud"), uid);
  const old = fsArr(doc, "men"), now = Date.now();
  await fsCommit(token, [{ update: { name: doc.name, fields: { text: { stringValue: text }, men: toFsValue(men), menN: toFsValue(menN), edited: { integerValue: String(now) } } },
    updateMask: { fieldPaths: ["text", "men", "menN", "edited"] }, currentDocument: { exists: true } }]);
  const rcp = {}; men.filter(u => old.indexOf(u) < 0).forEach(u => { rcp[u] = "mention"; });
  if (Object.keys(rcp).length) await momNotes(token, env, ctx, doc, uid, claims, rcp, { text });
  return { edited: now, men: men.length };
}
// فتحتُ الإشعارات ⇒ وقت آخر اطّلاع (يُزامَن على كلّ أجهزتي) + تنظيف ما تجاوز ٣٠ يوماً
async function opMomentSeen(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const ts = Math.min(Date.now(), Math.floor(Number(payload && payload.ts) || Date.now()));
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/mset/" + uid, fields: { seen: { integerValue: String(ts) } } }, updateMask: { fieldPaths: ["seen"] } }]);
  let gc = 0;
  try {
    const res = await fetch(FS_BASE + "/mnote/" + uid + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "n" }], orderBy: [{ field: { fieldPath: "__name__" }, direction: "DESCENDING" }], limit: 60 } }) });
    const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document).filter(d => fsInt(d, "ts") < Date.now() - 30 * 86400000);
    if (rows.length) { await fsCommit(token, rows.map(d => ({ delete: d.name }))); gc = rows.length; }
  } catch (e) { console.log("mnote gc:", e && e.message); }
  return { seen: ts, gc };
}
async function opMomentVote(uid, payload, env) {
  if (!codeRate(uid, "momv", 120)) throw new Error("rate_limited");
  const pid = String((payload && payload.pid) || ""), idx = Number(payload && payload.idx);
  if (!momPidOk(pid)) throw new Error("bad id");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const doc = await momGet(token, pid);
  if (!momCanSee(doc, uid)) throw new Error("not found");
  const poll = momMap(doc, "poll");
  if (!poll || !Array.isArray(poll.opts)) throw new Error("no poll");
  const del = idx === -1;
  if (!del && !(Number.isInteger(idx) && idx >= 0 && idx < poll.opts.length)) throw new Error("bad option");
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/moments/" + pid, fields: del ? {} : { votes: { mapValue: { fields: { [uid]: { integerValue: String(idx) } } } } } },
    updateMask: { fieldPaths: [fp("votes", uid)] }, currentDocument: { exists: true } }]);
  return { idx };
}
// Cron: حجوزات رفعٍ متروكة (لحظةٌ لم تُنشر) ⇒ حذف وسائطها
async function momentqGc(env, max) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "momentq" }], where: { fieldFilter: { field: { fieldPath: "ts" }, op: "LESS_THAN", value: { integerValue: String(Date.now() - 2 * 86400000) } } }, limit: max || 5 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let n = 0;
  for (const d of rows) {
    const pid = fstr(d, "pid"), mid = fstr(d, "mid");
    try { if (momPidOk(pid) && !(await momGet(token, pid))) await momDropMedia(token, pid, { mid, n: 40 }); await fsCommit(token, [{ delete: d.name }]); n++; } catch (e) { console.log("momentqGc:", e && e.message); }
  }
  return { gc: n };
}
// Cron: إزالة المنتهية ووسائطها
async function storyGc(env, max) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const now = Date.now();
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "stories" }], where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "exp" }, op: "GREATER_THAN", value: { integerValue: "0" } } },
      { fieldFilter: { field: { fieldPath: "exp" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } }] } }, limit: max || 2 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let n = 0;
  for (const d of rows) {
    const owner = d.name.split("/").pop(), all = storyItems(d);
    const gone = all.filter(x => Number(x.exp) <= now), keep = all.filter(x => Number(x.exp) > now);
    for (const it of gone.slice(0, 3)) await storyDropMedia(token, owner, it);
    const left = keep.concat(gone.slice(3));
    await storyWrite(token, owner, fstr(d, "name"), fsArr(d, "aud"), fsArr(d, "hide"), left).catch(() => {});
    n += Math.min(3, gone.length);
  }
  return { gc: n };
}
// v58: رموز سوا (١٠ أرقام) لجهات اتّصالي — بدل «عضو · A1B2». لجهات اتّصالي فقط (acl/{uid})، ولمن لم يُخفِ رمزه.
//      من لا رمز له بعد يُنشأ له (حتّى ٥ في الطلب).
async function opCodeOf(uid, payload, env) {
  if (!codeRate(uid, "codeof", 40)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const want = [...new Set((Array.isArray(payload && payload.uids) ? payload.uids : []).map(String).filter(segOk))].slice(0, 25);
  const acl = (await rtdbGet(token, "acl/" + uid).catch(() => null)) || {};
  const codes = {}; let made = 0;
  await Promise.all(want.filter(u => acl[u] === true && u !== uid).map(async (u) => {
    const acc = await fsGet(token, "accounts/" + u).catch(() => null);
    if (!acc || !accFindable(acc)) { codes[u] = null; return; }
    let c = fstr(acc, "code");
    if (!c && made < 5) { made++; c = (await ensureCode(token, u, null, false).catch(() => ({}))).code || ""; }
    codes[u] = c || null;
  }));
  return { codes };
}
function reqOut(d, dir) {
  const f = d.fields || {}, o = { uid: d.name.split("/").pop(), name: fstr(d, "name") || null, ts: fsInt(d, "ts"), code: fstr(d, "code") || null };
  if (dir === "in") o.text = fstr(d, "text") || "";
  return o;
}
async function opCodeRequests(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const [ins, outs, vins] = await Promise.all([fsList(token, "accounts/" + uid + "/creq"), fsList(token, "accounts/" + uid + "/creqout"), fsList(token, "accounts/" + uid + "/vouchin").catch(() => [])]);
  const by = (a, b) => b.ts - a.ts;
  return { incoming: ins.slice(0, 100).map(d => reqOut(d, "in")).sort(by), outgoing: outs.slice(0, 100).map(d => reqOut(d, "out")).sort(by),
    vouches: vins.slice(0, 50).map(d => ({ uid: d.name.split("/").pop(), name: fstr(d, "name") || null, phone: fstr(d, "phone") || null, ts: fsInt(d, "ts") })).sort(by) };
}
// القبول: جهتا اتّصال (كالرابط الشخصيّ) + محادثةٌ ثنائيّة أوّل رسائلها رسالة التعريف
async function acceptReq(token, me, from, claims, ctx) {
  const rq = await fsGet(token, "accounts/" + me + "/creq/" + from);
  const theirName = fstr(rq, "name") || null, text = fstr(rq, "text") || "";
  const myNm = await myName(token, me, claims);
  const now = Date.now(), iso = new Date(now).toISOString();
  const nameV = (n) => n ? { stringValue: n } : { nullValue: null };
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/accounts/" + me + "/people/" + from, fields: { ts: { timestampValue: iso }, name: nameV(theirName), anon: { booleanValue: false }, via: { stringValue: "code" } } } },
    { update: { name: DOC_ROOT + "/accounts/" + from + "/people/" + me, fields: { ts: { timestampValue: iso }, name: nameV(myNm), anon: { booleanValue: false }, via: { stringValue: "code" } } } },
    { delete: DOC_ROOT + "/accounts/" + me + "/creq/" + from },
    { delete: DOC_ROOT + "/accounts/" + from + "/creqout/" + me },
    { delete: DOC_ROOT + "/accounts/" + from + "/creq/" + me },
    { delete: DOC_ROOT + "/accounts/" + me + "/creqout/" + from },
  ]);
  try { await rtdbPatch(token, { ["acl/" + me + "/" + from]: true, ["acl/" + from + "/" + me]: true }); } catch (e) {}
  const cid = dmId(me, from);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/chats/" + cid, fields: { type: { stringValue: "dm" }, members: toFsValue([me, from].sort()),
    names: toFsValue({ [me]: myNm || null, [from]: theirName || null }), createdTs: { integerValue: String(now) }, createdBy: { stringValue: from },
    updatedTs: { integerValue: String(now) }, cnt: { integerValue: "0" } } }, currentDocument: { exists: false } }]).catch(() => {});
  await rtdbSetChatMembers(token, cid, [me, from]);
  if (text) {
    const day = dayKey(now), msg = { id: "rq" + now.toString(36) + Math.random().toString(36).slice(2, 6), by: from, ts: now, type: "text", text: text };
    await fsCommit(token, [
      { update: { name: DOC_ROOT + "/chats/" + cid + "/days/" + day, fields: { msgs: { mapValue: { fields: { [msg.id]: toFsValue(msg) } } } } },
        updateMask: { fieldPaths: [fp("msgs", msg.id)] } },
      { update: { name: DOC_ROOT + "/chats/" + cid, fields: {
          last: toFsValue({ id: msg.id, by: from, type: "text", text: text.slice(0, 120), ts: now, day: day }),
          updatedTs: { integerValue: String(now) },
          reads: { mapValue: { fields: { [from]: { integerValue: String(now) } } } },
          delivered: { mapValue: { fields: { [from]: { integerValue: String(now) } } } } } },
        updateMask: { fieldPaths: ["last", "updatedTs", fp("reads", from), fp("delivered", from)] },
        updateTransforms: [{ fieldPath: "cnt", increment: { integerValue: "1" } }, { fieldPath: fp("readCnt", from), increment: { integerValue: "1" } }],
        currentDocument: { exists: true } },
    ]).catch(e => console.log("seed msg:", e && e.message));
  }
  await sigTo(token, [from, me], "reqok");
  const job = pushTo(token, [from], strData({ t: "reqok", from: me, cid: cid, title: myNm || "سوا", body: "قبل طلب التواصل — يمكنكما المراسلة الآن ✓", ts: now }))
    .catch(e => console.log("push:", e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return { cid, uid: from, name: theirName };
}
async function opCodeRespond(uid, payload, env, claims, ctx) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const from = payload && payload.from, action = payload && payload.action;
  if (!segOk(from)) throw new Error("from required");
  if (["accept", "reject", "block"].indexOf(action) < 0) throw new Error("bad action");
  if (action === "accept") {
    if (!(await fsGet(token, "accounts/" + uid + "/creq/" + from))) throw new Error("request not found");
    return Object.assign({ accepted: true }, await acceptReq(token, uid, from, claims, ctx));
  }
  // الرفض: يُحذف الطلب عندي وحدي — يبقى عنده «بانتظار الموافقة» فلا يعرف أنّه رُفض ولا يكرّر الطلب
  await fsCommit(token, [{ delete: DOC_ROOT + "/accounts/" + uid + "/creq/" + from }]);
  if (action === "block") {
    const path = "accounts/" + uid + "/chatprefs/main";
    const cur = await fsGet(token, path);
    let data = {}; try { data = cur && fstr(cur, "data") ? JSON.parse(fstr(cur, "data")) : {}; } catch (e) { data = {}; }
    const bl = Array.isArray(data.blocked) ? data.blocked : [];
    if (bl.indexOf(from) < 0) bl.push(from);
    data.blocked = bl.slice(-500);
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/" + path, fields: { data: { stringValue: JSON.stringify(data) }, ts: { integerValue: String(Date.now()) } } } }]);
    try { await rtdbPatch(token, { ["blk/" + uid + "/" + from]: true }); } catch (e) {}
  }
  return { done: action };
}
async function opCodeCancel(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  let to = payload && payload.to;
  if (!to && payload && payload.code) { const t = await codeTarget(token, payload.code); to = t && t.uid; }
  if (!segOk(to)) throw new Error("to required");
  await fsCommit(token, [{ delete: DOC_ROOT + "/accounts/" + uid + "/creqout/" + to }, { delete: DOC_ROOT + "/accounts/" + to + "/creq/" + uid }]);
  return { cancelled: true };
}
async function opCodeReset(uid, payload, env, claims) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const acc = await fsGet(token, "accounts/" + uid).catch(() => null);
  if (fsInt(acc, "codeTs") && Date.now() - fsInt(acc, "codeTs") < 10 * 60 * 1000 && fstr(acc, "code")) throw new Error("wait");
  return await ensureCode(token, uid, claims, true);
}
async function opCodePrivacy(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const findable = !(payload && payload.findable === false);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/accounts/" + uid, fields: { findable: { booleanValue: findable } } }, updateMask: { fieldPaths: ["findable"] } }]);
  const pc = PROFILE_CACHE.get(uid); if (pc) pc.findable = findable;
  return { findable };
}

/* ---------- 32) حذف الحساب (شرط Google Play) ----------
   account.delete: فوراً — بيانات الحساب كلّها، روابط جهات الاتّصال والطلبات (في الاتّجاهين)، الرمز، الأجهزة، الإعدادات،
   المواعيد والدعوات التي أنشأها، عضويّته في المحادثات (رسائله عند الآخرين تبقى باسم «حساب محذوف»)، عضويّته في العائلات
   التي لا يملكها، الحضور والصلاحيّات في RTDB، ثمّ هويّة Firebase Auth نفسها.
   ما يحتاج طلباتٍ كثيرة يُكمله الـCron (purge/{id}، حدّ ٥٠ طلباً فرعيّاً لكلّ تشغيل):
     family — عائلةٌ يملكها: تنتقل ملكيّتها لأعلى عضوٍ رتبةً (محرّر ثمّ مشاهد، الأقدم أوّلاً)، أو تُحذف كاملةً إن كان وحده
     chat   — محادثته المحفوظة: الأيّام والوسائط وقطعها */
const DELETED_NAME = "حساب محذوف";
const GROUP_SUBS = ["persons", "relations", "events", "changelog", "photos", "members"];
async function opAccountDelete(uid, payload, env, claims) {
  if (!payload || payload.confirm !== "DELETE") throw new Error("confirm required");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const P = (rel) => DOC_ROOT + "/" + rel;
  const idOf = (d) => d.name.split("/").pop();
  const [acc, people, groups, devices, creq, creqout, contacts, schedules] = await Promise.all([
    fsGet(token, "accounts/" + uid).catch(() => null),
    ...["people", "groups", "devices", "creq", "creqout", "contacts", "schedules"].map(c => fsList(token, "accounts/" + uid + "/" + c).catch(() => [])),
  ]);
  const writes = [], rt = {}, purge = [], now = Date.now();
  // جهات الاتّصال والطلبات — في الاتّجاهين
  for (const d of people) { writes.push({ delete: d.name }, { delete: P("accounts/" + idOf(d) + "/people/" + uid) }); rt["acl/" + idOf(d) + "/" + uid] = null; }
  for (const d of creq) writes.push({ delete: d.name }, { delete: P("accounts/" + idOf(d) + "/creqout/" + uid) });
  for (const d of creqout) writes.push({ delete: d.name }, { delete: P("accounts/" + idOf(d) + "/creq/" + uid) });
  for (const d of devices.concat(contacts, schedules)) writes.push({ delete: d.name });
  writes.push({ delete: P("accounts/" + uid + "/chatprefs/main") });
  const code = fstr(acc, "code");
  if (code) writes.push({ delete: P("codes/" + code) });
  // العائلات: لا يملكها ⇒ يخرج الآن · يملكها ⇒ مهمّة للـCron (نقل الملكيّة أو الحذف الكامل)
  for (const d of groups) {
    const gid = idOf(d);
    writes.push({ delete: d.name });
    if (fstr(d, "role") === "owner") purge.push({ id: "fam_" + gid + "_" + uid, kind: "family", gid });
    else writes.push({ delete: P("groups/" + gid + "/members/" + uid) });
  }
  // المحادثات
  let chats = [];
  try {
    const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "chats" }], where: { fieldFilter: { field: { fieldPath: "members" }, op: "ARRAY_CONTAINS", value: { stringValue: uid } } }, limit: 300 } }) });
    chats = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  } catch (e) {}
  for (const c of chats) {
    const cid = idOf(c), type = fstr(c, "type");
    rt["chatm/" + cid + "/" + uid] = null; rt["typing/" + cid + "/" + uid] = null;
    if (type === "saved") {
      writes.push({ update: { name: c.name, fields: { deleted: { booleanValue: true }, members: toFsValue([]) } }, updateMask: { fieldPaths: ["deleted", "members"] } });
      purge.push({ id: "chat_" + cid, kind: "chat", cid });
      continue;
    }
    const members = fsArr(c, "members").filter(u => u !== uid);
    let admins = fsArr(c, "admins").filter(u => u !== uid);
    if (type === "group" && !admins.length && members.length) admins = [members[0]];
    const fields = { members: toFsValue(members), names: { mapValue: { fields: { [uid]: { stringValue: DELETED_NAME } } } } };
    const mask = ["members", fp("names", uid)];
    if (type === "group") { fields.admins = toFsValue(admins); mask.push("admins"); }
    if (!members.length) { fields.deleted = { booleanValue: true }; mask.push("deleted"); }
    writes.push({ update: { name: c.name, fields }, updateMask: { fieldPaths: mask } });
  }
  // المواعيد التي أنشأها ودعوات «رابطي الشخصيّ»
  for (const s of await fsQueryEq(token, "scheds", { by: uid }, 100).catch(() => [])) writes.push({ delete: s.name });
  for (const s of await fsQueryEq(token, "pinvites", { uid: uid }, 100).catch(() => [])) writes.push({ delete: s.name });
  for (const t of purge) writes.push({ update: { name: P("purge/" + t.id), fields: { kind: { stringValue: t.kind }, uid: { stringValue: uid },
    gid: t.gid ? { stringValue: t.gid } : { nullValue: null }, cid: t.cid ? { stringValue: t.cid } : { nullValue: null }, ts: { integerValue: String(now) } } } });
  writes.push({ delete: P("accounts/" + uid) });
  writes.push({ delete: P("avatars/" + uid) });   // v37: الصورة
  await commitChunks(token, writes);
  // RTDB: حضوري، صلاحيّاتي، صندوق مكالماتي، ومن كان يرى حضوري
  try { const acl = await rtdbGet(token, "acl/" + uid); for (const o in (acl || {})) rt["acl/" + o + "/" + uid] = null; } catch (e) {}
  Object.assign(rt, { ["status/" + uid]: null, ["acl/" + uid]: null, ["inbox/" + uid]: null, ["blk/" + uid]: null });
  try { await rtdbPatch(token, rt); } catch (e) { console.log("rtdb del:", e && e.message); }
  PROFILE_CACHE.delete(uid);
  // الهويّة نفسها (Firebase Auth) — آخر خطوة
  let authDeleted = false;
  try {
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/projects/" + PROJECT_ID + "/accounts:delete", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ localId: uid }) });
    authDeleted = r.ok;
    if (!r.ok) console.log("auth delete:", r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.log("auth delete:", e && e.message); }
  return { deleted: true, authDeleted, queued: purge.length, chats: chats.length, contacts: people.length };
}
// الـCron: يكمل مهامّ purge ضمن حدٍّ من الطلبات الفرعيّة (budget). المهمّة تبقى حتّى تكتمل.
async function purgeWork(env, budget) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  let used = 1, done = 0;
  const spend = (n) => { used += n || 1; return used <= budget; };
  const jobs = await fsList(token, "purge").catch(() => []); used++;
  for (const j of jobs.slice(0, 5)) {
    if (used >= budget) break;
    const kind = fstr(j, "kind"), uid = fstr(j, "uid");
    let finished = false;
    try {
      if (kind === "family") finished = await purgeFamily(token, fstr(j, "gid"), uid, spend);
      else if (kind === "chat") finished = await purgeChat(token, fstr(j, "cid"), spend);
      else finished = true;
    } catch (e) { console.log("purge:", kind, e && e.message); }
    if (finished && spend()) { await fsCommit(token, [{ delete: j.name }]).catch(() => {}); done++; }
  }
  return { purged: done, used };
}
// يحذف مستندات مجموعةٍ فرعيّة على دفعات (قائمة ٣٠٠ + commit) — يعيد true إن فرغت
async function purgeColl(token, rel, spend) {
  for (;;) {
    if (!spend()) return false;
    const res = await fetch(FS_BASE + "/" + rel + "?pageSize=300&mask.fieldPaths=__none__", { headers: { Authorization: "Bearer " + token } });
    if (res.status === 404) return true;
    const b = await res.json(); const docs = (b && b.documents) || [];
    if (!docs.length) return true;
    if (!spend()) return false;
    await fsCommit(token, docs.map(d => ({ delete: d.name })));
    if (docs.length < 300) return true;
  }
}
async function purgeFamily(token, gid, uid, spend) {
  if (!spend()) return false;
  const members = await fsList(token, "groups/" + gid + "/members");
  const live = members.filter(m => m.name.split("/").pop() !== uid && fstr(m, "adoptedFrom") !== uid);
  if (live.length) {
    // نقل الملكيّة: محرّر قبل مشاهد، والأقدم انضماماً أوّلاً
    const rank = (m) => ROLE_RANK[fstr(m, "role")] || 0;
    const ts = (m) => { const v = m.fields && m.fields.joinedTs && m.fields.joinedTs.timestampValue; return v ? Date.parse(v) : 0; };
    live.sort((a, b) => rank(b) - rank(a) || ts(a) - ts(b));
    const heir = live[0].name.split("/").pop();
    if (!spend()) return false;
    const g = await fsGet(token, "groups/" + gid);
    if (!spend()) return false;
    await fsCommit(token, [
      { update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + heir, fields: { role: { stringValue: "owner" } } }, updateMask: { fieldPaths: ["role"] } },
      indexWrite(heir, gid, fstr(g, "name"), "owner", new Date().toISOString()),
      { delete: DOC_ROOT + "/groups/" + gid + "/members/" + uid },
    ]);
    if (spend(3)) { try { await famChatSync(token, gid); } catch (e) {} }
    return true;
  }
  // وحده فيها: حذفٌ كامل للشجرة
  for (const sub of GROUP_SUBS) if (!(await purgeColl(token, "groups/" + gid + "/" + sub, spend))) return false;
  if (!spend(2)) return false;
  await fsCommit(token, [{ delete: DOC_ROOT + "/groups/" + gid }, { delete: DOC_ROOT + "/chats/fam_" + gid }]).catch(() => {});
  try { await rtdbPatch(token, { ["chatm/fam_" + gid]: null }); } catch (e) {}
  return true;
}
async function purgeChat(token, cid, spend) {
  if (!segOk(cid)) return true;
  if (!(await purgeColl(token, "chats/" + cid + "/days", spend))) return false;
  if (!spend()) return false;
  const media = await fsList(token, "chats/" + cid + "/media").catch(() => []);
  for (const m of media) {
    if (!(await purgeColl(token, "chats/" + cid + "/media/" + m.name.split("/").pop() + "/c", spend))) return false;
    if (!spend()) return false;
    await fsCommit(token, [{ delete: m.name }]).catch(() => {});
  }
  if (!spend()) return false;
  await fsCommit(token, [{ delete: DOC_ROOT + "/chats/" + cid }]).catch(() => {});
  return true;
}

/* ---------- 33) لوحة الاستهلاك (للمدير) ----------
   عدّاداتٌ يوميّة في stats/{YYYYMMDD}: الطلبات لكلّ عمليّة (ops.*) · الأخطاء (err.*) · الإشعارات المرسلة · بيانات TURN المُعطاة لكلّ مزوّد.
   تُجمَع في الذاكرة وتُرسَل دفعةً (كلّ ٤٠ حدثاً أو ٥ دقائق) بزياداتٍ ذرّيّة — كتابةٌ واحدة بدل كتابةٍ لكلّ طلب.
   admin.stats: للمدير وحده (السرّ ADMIN_EMAIL = بريد حسابه في Google، مؤكَّد). */
const STATS = { day: null, n: 0, at: Date.now(), m: {} };
const HEAVY_OPS = new Set(["boot", "people.list", "profile.set", "account.delete", "gcall.start", "gcall.add", "sched.set", "bulk.import", "account.adopt", "group.members"]);
function stat(key, k) {
  const d = dayKey(Date.now());
  if (STATS.day !== d) { STATS.day = d; STATS.m = {}; STATS.n = 0; STATS.at = Date.now(); }
  STATS.m[key] = (STATS.m[key] || 0) + (k || 1); STATS.n++;
}
async function flushStats(env, force) {
  if (!STATS.n || !env.SA_JSON || (!force && STATS.n < 40 && Date.now() - STATS.at < 300000)) return;
  const m = STATS.m, d = STATS.day; STATS.m = {}; STATS.n = 0; STATS.at = Date.now();
  try {
    const token = await getAccessToken(JSON.parse(env.SA_JSON));
    const tr = Object.keys(m).map(k => { const [a, b] = k.split(":"); return { fieldPath: b ? fp(a, b) : fp(a), increment: { integerValue: String(m[k]) } }; });
    await fsCommit(token, [{ update: { name: DOC_ROOT + "/stats/" + d, fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: tr }]);
  } catch (e) { console.log("stats:", e && e.message); }
}
function isAdmin(env, claims) {
  const want = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  return !!(want && claims && claims.email && claims.email_verified && String(claims.email).toLowerCase() === want);
}
async function opAdminStats(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  await flushStats(env, true);
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const days = (await fsList(token, "stats").catch(() => [])).map(d => ({ day: d.name.split("/").pop(), v: fsToJs({ mapValue: { fields: d.fields || {} } }) || {} }))
    .sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
  const cnt = async (c) => {   // عدّ مجموعةٍ في الجذر (قراءةٌ واحدة لكلّ ١٠٠٠ وثيقة)
    try {
      const res = await fetch(FS_BASE + ":runAggregationQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: c }] }, aggregations: [{ alias: "n", count: {} }] } }) });
      const r = ((await res.json()) || []).find(x => x.result);
      const v = r && r.result.aggregateFields && r.result.aggregateFields.n;
      return v ? Number(v.integerValue || 0) : 0;
    } catch (e) { return null; }
  };
  const [accounts, chats, groups, purge, openReports] = await Promise.all([cnt("accounts"), cnt("chats"), cnt("groups"), cnt("purge"),
    fsQueryEq(token, "reports", { status: "open" }, 100).then(r => r.length).catch(() => null)]);
  return { admin: true, days, totals: { accounts, chats, groups, purgePending: purge, openReports }, ver: VER };
}

/* ---------- 34) البلاغات (سياسة Google Play للمحتوى من المستخدمين) ----------
   report.create {cid?, target?, reason, note}: المبلِّغ عضوٌ في المحادثة ⇒ يُرفق آخر ٢٠ رسالة (نصوصها مقتطعة) ليراجعها المدير.
   reports/{id} = { by, byName, target, cid, type, reason, note, sample(JSON), ts, status: open|closed } — للخادم وحده.
   admin.reports / admin.reportClose: للمدير (ADMIN_EMAIL). */
const REPORT_REASONS = ["spam", "harassment", "hate", "violence", "sexual", "scam", "impersonation", "other"];
async function recentMsgs(token, cid, n) {
  const res = await fetch(FS_BASE + "/chats/" + cid + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "days" }], orderBy: [{ field: { fieldPath: "__name__" }, direction: "DESCENDING" }], limit: 2 } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  let all = [];
  for (const d of rows) { const m = fsToJs((d.fields || {}).msgs || { nullValue: null }) || {}; for (const k in m) all.push(m[k]); }
  return all.filter(x => x && !x.gone && x.type !== "system").sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-n)
    .map(x => ({ by: x.by || null, type: x.type || "text", text: typeof x.text === "string" ? x.text.slice(0, 300) : "", ts: x.ts || 0 }));
}
async function opReportCreate(uid, payload, env, claims) {
  if (!codeRate(uid, "report", 10)) throw new Error("rate_limited");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  payload = payload || {};
  const reason = REPORT_REASONS.indexOf(payload.reason) >= 0 ? payload.reason : "other";
  const note = String(payload.note || "").replace(/\s+/g, " ").trim().slice(0, 500);
  let cid = payload.cid || null, target = payload.target || null, type = null, sample = [];
  if (cid) {
    if (!segOk(cid)) throw new Error("bad cid");
    const c = await requireChatMember(token, cid, uid);
    type = fstr(c, "type");
    if (!target && type === "dm") target = fsArr(c, "members").find(x => x !== uid) || null;
    try { sample = await recentMsgs(token, cid, 20); } catch (e) {}
    // v36: السرّيّة لا يقرؤها الخادم — المُبلِّغ يرفق آخر رسائلها من جهازه (مفكوكةً) ليراجعها فريقنا
    if (e2eOf(c) && Array.isArray(payload.e2eSample)) sample = payload.e2eSample.slice(-20).map(x => ({ by: segOk(String((x && x.by) || "")) ? x.by : null,
      type: "text", text: String((x && x.text) || "").slice(0, 300), ts: Number((x && x.ts) || 0) || 0, e2e: true }));
  }
  // C150: الإبلاغ عن لحظة أو تعليق — يُرفق نصّها، ويُسجَّل المبلِّغ عليها؛ ٣ مبلِّغين مختلفين ⇒ تُحجب عن الجميع (held) حتّى يراجعها المدير
  let pid = null, cmid = null;
  if (payload.moment && typeof payload.moment === "object") {
    pid = String(payload.moment.pid || ""); cmid = payload.moment.cmid ? String(payload.moment.cmid) : null;
    if (!momPidOk(pid) || (cmid && !momCmidOk(cmid))) throw new Error("bad id");
    const md = await momGet(token, pid);
    if (!momCanSee(md, uid)) throw new Error("not found");
    let tgtDoc = md, path = "moments/" + pid;
    if (cmid) { tgtDoc = await fsGet(token, path + "/cm/" + cmid).catch(() => null); if (!tgtDoc || !tgtDoc.fields) throw new Error("comment gone"); path += "/cm/" + cmid; }
    type = cmid ? "moment-comment" : "moment"; target = fstr(tgtDoc, "by") || target;
    sample = [{ by: target, type: type, text: fstr(tgtDoc, "text").slice(0, 600), media: cmid ? 0 : (momMap(md, "media") || []).length, ts: fsInt(tgtDoc, "ts"), pid, cmid }];
    const reps = fsArr(tgtDoc, "reps");
    if (reps.indexOf(uid) < 0) {
      const held = reps.length + 1 >= 3;
      await fsCommit(token, [{ update: { name: DOC_ROOT + "/" + path, fields: held ? { held: { booleanValue: true } } : {} }, updateMask: { fieldPaths: held ? ["held"] : [] },
        updateTransforms: [{ fieldPath: "reps", appendMissingElements: { values: [{ stringValue: uid }] } }], currentDocument: { exists: true } }]).catch(e => console.log("reps:", e && e.message));
    }
  }
  if (target && !segOk(String(target))) throw new Error("bad target");
  if (!cid && !target) throw new Error("nothing to report");
  const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), now = Date.now();
  const me = memberIdFields(claims);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/reports/" + id, fields: {
    by: { stringValue: uid }, byName: me.name, target: target ? { stringValue: target } : { nullValue: null }, cid: cid ? { stringValue: cid } : { nullValue: null },
    type: type ? { stringValue: type } : { nullValue: null }, reason: { stringValue: reason }, note: { stringValue: note },
    pid: pid ? { stringValue: pid } : { nullValue: null }, cmid: cmid ? { stringValue: cmid } : { nullValue: null },
    sample: { stringValue: JSON.stringify(sample) }, ts: { integerValue: String(now) }, status: { stringValue: "open" } } } }]);
  stat("report");
  return { id };
}
/* ---------- C131) تقييم جودة المكالمات ----------
   qa.rate: المختبِر (أو المدير) يقيّم المكالمة بعد انتهائها مع قياساتها ⇒ qa/{id} = { by, byName, ts, d(JSON) } — للخادم وحده.
   admin.qa: آخر التقييمات للمدير (ADMIN_EMAIL) ليقارن المحرّكات والنسخ بالأرقام لا بالانطباع. */
function qaNum(v, lo, hi) { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 10) / 10)) : null; }
function qaStatClean(x) { if (!x || typeof x !== "object") return null; return { med: qaNum(x.med, 0, 1e5), p90: qaNum(x.p90, 0, 1e5), max: qaNum(x.max, 0, 1e5), n: qaNum(x.n, 0, 1e4) }; }
async function opQaRate(uid, payload, env, claims) {
  if (!codeRate(uid, "qa", 40)) throw new Error("rate_limited");
  const p = payload || {}, stars = Math.round(Number(p.stars));
  if (!(stars >= 1 && stars <= 5)) throw new Error("bad stars");
  const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
  const TAGS = ["echo", "noise", "cut", "delay", "low", "drop"];
  const d = { stars, tags: (Array.isArray(p.tags) ? p.tags : []).filter(t => TAGS.indexOf(t) >= 0).slice(0, 6), note: str(p.note, 200),
    kind: str(p.kind, 16), engine: p.engine === "native" || p.engine === "native-ios" ? p.engine : "web", osr: str(p.osr, 40), secs: qaNum(p.secs, 0, 36000), out: str(p.out, 6), route: str(p.route, 10),
    relay: str(p.relay, 40), proto: str(p.proto, 6), colo: str(p.colo, 6), n: qaNum(p.n, 1, 50), reason: str(p.reason, 16), ver: str(p.ver, 12),
    plat: str(p.plat, 40), model: str(p.model, 40), lang: p.lang === "en" ? "en" : "ar", rtt: qaStatClean(p.rtt), jb: qaStatClean(p.jb), loss: qaStatClean(p.loss) };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const id = "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), now = Date.now();
  const me = memberIdFields(claims);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/qa/" + id, fields: { by: { stringValue: uid }, byName: me.name, ts: { integerValue: String(now) }, d: { stringValue: JSON.stringify(d) } } } }]);
  stat("qa:" + d.engine);
  return { id };
}
async function opAdminQa(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const lim = Math.max(1, Math.min(500, Number((payload && payload.limit) || 300)));
  const res = await fetch(FS_BASE + ":runQuery", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "qa" }], orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }], limit: lim } }) });
  const rows = ((await res.json()) || []).filter(r => r.document).map(r => r.document);
  const items = rows.map(doc => { const v = fsToJs({ mapValue: { fields: doc.fields || {} } }) || {}; let d = {}; try { d = JSON.parse(v.d || "{}"); } catch (e) {}
    return Object.assign(d, { id: doc.name.split("/").pop(), by: v.by, byName: v.byName, ts: v.ts }); });
  return { admin: true, items };
}
async function opAdminReports(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const docs = await fsQueryEq(token, "reports", { status: "open" }, 30).catch(() => []);
  const items = docs.map(d => { const v = fsToJs({ mapValue: { fields: d.fields || {} } }) || {}; let sample = []; try { sample = JSON.parse(v.sample || "[]"); } catch (e) {}
    return { id: d.name.split("/").pop(), by: v.by, byName: v.byName, target: v.target, cid: v.cid, type: v.type, reason: v.reason, note: v.note, ts: v.ts, sample, pid: v.pid || null, cmid: v.cmid || null }; })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { admin: true, items };
}
async function opAdminReportClose(uid, payload, env, claims) {
  if (!isAdmin(env, claims)) return { admin: false };
  const id = payload && payload.id;
  if (!segOk(String(id || ""))) throw new Error("id required");
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  // C150: «لا مخالفة» ⇒ تُرفع الحجب عن اللحظة/التعليق ويُصفَّر عدّاد المبلِّغين
  if (payload.release) {
    const rp = await fsGet(token, "reports/" + id).catch(() => null), pid = rp && fstr(rp, "pid"), cmid = rp && fstr(rp, "cmid");
    if (pid && momPidOk(pid)) await fsCommit(token, [{ update: { name: DOC_ROOT + "/moments/" + pid + (cmid ? "/cm/" + cmid : ""), fields: { held: { booleanValue: false }, reps: { arrayValue: { values: [] } } } },
      updateMask: { fieldPaths: ["held", "reps"] }, currentDocument: { exists: true } }]).catch(() => {});
  }
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/reports/" + id, fields: { status: { stringValue: "closed" }, closedTs: { integerValue: String(Date.now()) } } },
    updateMask: { fieldPaths: ["status", "closedTs"] }, currentDocument: { exists: true } }]);
  return { admin: true, closed: id };
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
  // Cron (wrangler.toml: [triggers] crons = ["*/5 * * * *"]): تذكيرات المواعيد كلّ تشغيل؛ والتنظيف بالتناوب
  // (حدّ ٥٠ طلباً فرعيّاً لكلّ تشغيل: لا تنظيف في تشغيلٍ أرسل تذكيراً)
  async scheduled(event, env, ctx) {
    PUSH_ENV = env; notifyChat.env = env;
    ctx.waitUntil((async () => {
      const L = LIM(env);
      await flushStats(env, true);
      let r = { reminders: 0 };
      try { r = await schedReminders(env); } catch (e) { console.log("reminders:", e && e.message); }
      try { await taskReminders(env); } catch (e) { console.log("taskrem:", e && e.message); }   // C173
      const job = (name, f) => f().catch(e => console.log(name + ":", e && e.message));
      if (L.free) {   // المجّانيّة: ٥٠ طلباً فرعيّاً ⇒ مهمّةٌ واحدة في كلّ تشغيل (كما في C178)
        if (r.reminders) return;
        const slot = Math.floor(new Date(event.scheduledTime || Date.now()).getUTCMinutes() / 5) % 4;
        if (slot === 3) return job("health", () => healthRun(env));
        if (slot === 0) { await job("cleanup", () => cleanupDisappearing(env)); await job("tel gc", () => telGc(env, 100)); }
        else if (slot === 1) { await job("calls cleanup", () => cleanupCalls(env)); await job("media gc", () => mediaGc(env, L.media)); await job("story gc", () => storyGc(env, L.story)); await job("storyq gc", () => storyqGc(env, L.q)); await job("momentq gc", () => momentqGc(env, L.q)); }
        else await job("purge", () => purgeWork(env, L.purge));
        return;
      }
      // C180: الخطّة المدفوعة — كلّ المهامّ في كلّ تشغيل (المراقبة كلّ ٥ دقائق)
      await Promise.all([job("health", () => healthRun(env)), job("cleanup", () => cleanupDisappearing(env)), job("calls cleanup", () => cleanupCalls(env)), job("quality", () => qualityWatch(env))]);   // C181: ملخّص الجودة
      await job("media gc", () => mediaGc(env, L.media)); await job("story gc", () => storyGc(env, L.story));
      await job("storyq gc", () => storyqGc(env, L.q)); await job("momentq gc", () => momentqGc(env, L.q)); await job("tel gc", () => telGc(env, 200));
      await job("purge", () => purgeWork(env, L.purge));   // حذف الحسابات: ما تبقّى من عائلاتٍ ومحادثات
    })());
  },
  async fetch(request, env, ctx) {
    PUSH_ENV = env;   // C151
    notifyChat.env = env;   // v65: توقيع إقرار «وصلت» في إشعارات الرسائل
    try { const u0 = new URL(request.url); if (isAuthProxyPath(u0.pathname)) return await authProxy(request, u0); } catch (e) { return new Response("auth proxy error", { status: 502 }); }
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try { if (new URL(request.url).pathname === "/wa/webhook") return await waWebhook(request, env, ctx); } catch (e) { return new Response("webhook error", { status: 500 }); }
    try { if (request.method === "POST" && new URL(request.url).pathname === "/ack") return await deviceAck(request, env); } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
    try { if (request.method === "GET" && new URL(request.url).pathname === "/av") return await avatarImg(request, env); } catch (e) { return new Response("", { status: 500 }); }   // C152
    let statOp = null;
    try {
      const auth = request.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (!m) return json({ ok: false, error: "no bearer token" }, 401);
      let claims = await verifyIdToken(m[1]);
      const uid = claims.sub;

      // حدٌّ لكلّ مستخدم (تقريبيّ، لكلّ نسخةٍ من الـWorker): يحمي الحصّة المجانيّة من عميلٍ معطوب أو مسيء
      if (!rateOk(uid)) return json({ ok: false, error: "rate_limited" }, 429);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const op = body.op || "whoami";
      statOp = String(op).replace(/[^a-z0-9._-]/gi, "").slice(0, 40) || "?";
      stat("ops:" + statOp); stat("req");
      // العمليّات الثقيلة قريبة من حدّ ٥٠ طلباً فرعيّاً — لا نضيف إليها الإرسال
      if (ctx && ctx.waitUntil && !HEAVY_OPS.has(statOp)) ctx.waitUntil(flushStats(env));
      const bad = badIds(body.payload);
      if (bad) return json({ ok: false, error: "bad id: " + bad }, 400);

      // اسم «سوا» المحفوظ يسبق اسم Google في كلّ العمليّات (ذاكرة مؤقّتة — لا قراءة في كلّ طلب)
      if (op !== "whoami" && op !== "rtc.ice" && op !== "chat.mark" && env.SA_JSON) {
        try { const pr = await profileOf(await getAccessToken(JSON.parse(env.SA_JSON)), uid); claims = Object.assign({}, claims, { sawaName: pr.name || null, sawaPhone: pr.phone || null }); } catch (e) {}
      }
      if (op === "profile.get") { const r = await opProfileGet(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "profile.set") { const r = await opProfileSet(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "phone.start") { const r = await opPhoneStart(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "phone.status") { const r = await opPhoneStatus(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "find.phone") { const r = await opFindBy(uid, body.payload, env, "phone"); return json({ ok: true, ...r }); }
      // C53: طلبٌ واحد عند الإقلاع بدل ثلاثة (people.list + chat.prefs + code.requests) — يوفّر رحلتين إلى الخادم على الشبكات البطيئة
      if (op === "boot") {
        const [people, prefs, requests] = await Promise.all([opPeopleList(uid, {}, env, claims), opChatPrefs(uid, {}, env), opCodeRequests(uid, {}, env)]);
        return json({ ok: true, people, prefs, requests });
      }
      if (op === "link.peek") { const r = await opLinkPeek(uid, body.payload, env); return json(r); }
      if (op === "find.email") { const r = await opFindBy(uid, body.payload, env, "email"); return json({ ok: true, ...r }); }
      if (op === "sfu.cfg") { const r = await opSfuCfg(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sfu.new") { const r = await opSfuNew(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sfu.push") { const r = await opSfuPush(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sfu.pull") { const r = await opSfuPull(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sfu.reneg") { const r = await opSfuReneg(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sfu.close") { const r = await opSfuClose(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "vouch.request") { const r = await opVouchRequest(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "vouch.respond") { const r = await opVouchRespond(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "whoami")
        return json({ ok: true, uid, provider: claims.firebase && claims.firebase.sign_in_provider, admin: isAdmin(env, claims) });   // v37: «فحص الاتّصال» للمدير وحده
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
      if (op === "chat.pollKeys") { const r = await opChatPollKeys(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.vote") { const r = await opChatVote(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.pollEdit") { const r = await opChatPollEdit(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.billPaid") { const r = await opChatBillPaid(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.fund") { const r = await opChatFund(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "chat.task") { const r = await opChatTask(uid, body.payload, env, ctx); return json({ ok: true, ...r }); }
      if (op === "chat.taskAdd") { const r = await opChatTaskAdd(uid, body.payload, env, ctx); return json({ ok: true, ...r }); }   // C173
      if (op === "chat.myTasks") { const r = await opChatMyTasks(uid, body.payload, env); return json({ ok: true, ...r }); }   // C173
      if (op === "chat.tasksEdit") { const r = await opChatTasksEdit(uid, body.payload, env, ctx); return json({ ok: true, ...r }); }   // C164
      if (op === "chat.open") { const r = await opChatOpen(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "chat.send") { const r = await opChatSend(uid, body.payload, env, ctx); return json({ ok: true, ...r }); }
      if (op === "e2e.dm") { const r = await opE2eDm(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "e2e.group") { if (!body.payload || !body.payload.e2e) throw new Error("bad e2e key"); const r = await opGroupCreate2(uid, body.payload, env, claims); return json({ ok: true, e2e: true, ...r }); }
      if (op === "e2e.join") { const r = await opE2eJoin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "rtc.ice") { const r = await opRtcIce(uid, body.payload, env, claims, request); return json({ ok: true, ...r }); }
      if (op === "call.ring") { const r = await opCallRing(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "gcall.start") { const r = await opGcallStart(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "gcall.room") { const r = await opGcallRoom(uid, body.payload, env); return json({ ok: true, ...r }); }   // C178
      if (op === "gcall.add") { const r = await opGcallAdd(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "sched.set") { const r = await opSchedSet(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "sched.join") { const r = await opSchedJoin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sched.list") { const r = await opSchedList(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "sched.delete") { const r = await opSchedDelete(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "call.missed") { const r = await opCallMissed(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "push.test") { const r = await opPushTest(uid, body.payload, env, ctx); return json({ ok: true, ...r }); }
      if (op === "push.check") { const r = await opPushCheck(uid, body.payload, env); return json({ ok: true, ...r }); }
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
      if (op === "media.begin") { const r = await opMediaBegin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "story.begin") { const r = await opStoryBegin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "people.peek") { const r = await opPeoplePeek(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.peek") { const r = await opGroupPeek(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "people.accept") { const r = await opPeopleAccept(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "story.post") { const r = await opStoryPost(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "story.delete") { const r = await opStoryDelete(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "story.view") { const r = await opStoryView(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "story.audience") { const r = await opStoryAudience(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "code.of") { const r = await opCodeOf(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "code.mine") { const r = await opCodeMine(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "code.find") { const r = await opCodeFind(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "code.request") { const r = await opCodeRequest(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "code.requests") { const r = await opCodeRequests(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "code.respond") { const r = await opCodeRespond(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "code.cancel") { const r = await opCodeCancel(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "code.reset") { const r = await opCodeReset(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "code.privacy") { const r = await opCodePrivacy(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "account.delete") { const r = await opAccountDelete(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "report.create") { const r = await opReportCreate(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "voip.test") { const r = await opVoipTest(uid, body.payload, env, claims); return json({ ok: true, ...r }); }   // C151
      if (op === "admin.reports") { const r = await opAdminReports(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "admin.reportClose") { const r = await opAdminReportClose(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "moment.begin") { const r = await opMomentBegin(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "moment.post") { const r = await opMomentPost(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "moment.delete") { const r = await opMomentDelete(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "moment.like") { const r = await opMomentLike(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "moment.comment") { const r = await opMomentComment(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "moment.uncomment") { const r = await opMomentUncomment(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "moment.vote") { const r = await opMomentVote(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "moment.creact") { const r = await opMomentCReact(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }   // C135
      if (op === "moment.cedit") { const r = await opMomentCEdit(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }   // C136
      if (op === "moment.edit") { const r = await opMomentEdit(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "moment.seen") { const r = await opMomentSeen(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "moment.prefs") { const r = await opMomentPrefs(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "call.tel") { const r = await opCallTel(uid, body.payload, env); return json({ ok: true, ...r }); }   // C179
      if (op === "admin.qcfg") { const r = await opAdminQcfg(uid, body.payload, env, claims); return json({ ok: true, ...r }); }   // C181
      if (op === "admin.tel") { const r = await opAdminTel(uid, body.payload, env, claims); return json({ ok: true, ...r }); }   // C179
      if (op === "qa.rate") { const r = await opQaRate(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "admin.health") { const r = await opAdminHealth(uid, body.payload, env, claims); return json({ ok: true, ...r }); }   // C178
      if (op === "admin.relay") { const r = await opAdminRelay(uid, body.payload, env, claims); return json({ ok: true, ...r }); }   // C175
      if (op === "admin.qa") { const r = await opAdminQa(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "admin.stats") { const r = await opAdminStats(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "people.remove") { const r = await opPeopleRemove(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "fam.suggest") { const r = await opFamSuggest(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "fam.linkReq") { const r = await opFamLinkReq(uid, body.payload, env, claims, ctx); return json({ ok: true, ...r }); }
      if (op === "fam.reqs") { const r = await opFamReqs(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "fam.linkRespond") { const r = await opFamLinkRespond(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "fam.claim") { const r = await opFamClaim(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "member.hello") { const r = await opMemberHello(uid, body.payload, env, claims); return json({ ok: true, ...r }); }
      if (op === "member.setRole") { const r = await opMemberSetRole(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "member.banned") { const r = await opMemberBanned(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "member.unban") { const r = await opMemberUnban(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "member.remove") { const r = await opMemberRemove(uid, body.payload, env); return json({ ok: true, ...r }); }
      if (op === "group.settings") { const r = await opGroupSettings(uid, body.payload, env); return json({ ok: true, ...r }); }
      return json({ ok: false, error: "unknown op: " + op }, 400);
    } catch (e) {
      if (statOp) { stat("err:" + statOp); if (ctx && ctx.waitUntil) ctx.waitUntil(flushStats(env)); }
      return json({ ok: false, error: String((e && e.message) || e) }, 401);
    }
  },
};
