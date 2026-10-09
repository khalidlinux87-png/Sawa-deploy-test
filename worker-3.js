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

const VER = "v5-review-import";  // علامة الإصدار — تظهر في كلّ ردّ
const PROJECT_ID = "sawa-test-9770f";
const ISS = "https://securetoken.google.com/" + PROJECT_ID;
const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
// مسار المستند النسبيّ (يُستعمل في حقل name داخل الكتابة)
const DOC_ROOT = "projects/" + PROJECT_ID + "/databases/(default)/documents";
// الرابط الكامل (يُستعمل لاستدعاء الـAPI فقط)
const FS_BASE = "https://firestore.googleapis.com/v1/" + DOC_ROOT;

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
    scope: "https://www.googleapis.com/auth/datastore",
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
async function opGroupCreate(uid, payload, env) {
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
      fields: { role: { stringValue: "owner" }, joinedTs: { timestampValue: now } } } },
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
  const inviteToken = crypto.randomUUID();
  const now = new Date().toISOString();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/invites/" + inviteToken,
      fields: { groupId: { stringValue: groupId }, createdBy: { stringValue: uid },
                role: { stringValue: "viewer" }, createdTs: { timestampValue: now } } } },
  ]);
  return { token: inviteToken, groupId: groupId };
}

/* ---------- 6) العمليّة: invite.accept (أيّ مستخدم مُتحقَّق) ---------- */
async function opInviteAccept(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const inviteToken = payload && payload.token;
  if (!inviteToken) throw new Error("invite token required");
  const invite = await fsGet(token, "invites/" + inviteToken);
  if (!invite) throw new Error("invite not found");
  const groupId = fstr(invite, "groupId");
  const invitedBy = fstr(invite, "createdBy") || "";
  // عضوٌ سلفاً؟ لا نُنزِل دوره
  const existing = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  if (existing) return { groupId: groupId, role: fstr(existing, "role"), already: true };
  const now = new Date().toISOString();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/members/" + uid,
      fields: { role: { stringValue: "viewer" }, joinedTs: { timestampValue: now },
                invitedBy: { stringValue: invitedBy } } } },
  ]);
  return { groupId: groupId, role: "viewer" };
}

/* يتحقّق أنّ المستخدم محرِّر/مالك في العائلة */
async function requireEditor(token, groupId, uid) {
  const me = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const role = fstr(me, "role");
  if (role !== "owner" && role !== "editor") throw new Error("not allowed to edit");
  return role;
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
  const ALLOWED = ["local_name", "gender", "kinship", "birthYear", "deathYear", "phones", "notes"];

  const now = new Date().toISOString();
  let pid = payload.personId, creating = false;
  if (pid) { const ex = await fsGet(token, "groups/" + groupId + "/persons/" + pid); if (!ex) creating = true; }
  else { pid = crypto.randomUUID(); creating = true; }

  const changed = [], updFields = {}, ftsSub = {};
  for (const k of ALLOWED) if (k in fields) { updFields[k] = toFsValue(fields[k]); ftsSub[k] = { timestampValue: now }; changed.push(k); }
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
  if (["parent", "spouse", "ex_spouse"].indexOf(type) < 0) throw new Error("bad relation type");
  if (!from || !to) throw new Error("from/to required");
  if (from === to) throw new Error("from equals to");

  const relDocs = await fsList(token, "groups/" + groupId + "/relations");
  const active = relDocs.filter(d => !fbool(d, "deleted"))
    .map(d => ({ type: fstr(d, "type"), from: fstr(d, "from"), to: fstr(d, "to") }));
  if (active.some(r => r.type === type && r.from === from && r.to === to))
    return { applied: false, reason: "exists" };

  let conflict = null;
  if (type === "parent") {
    // حارس مقعد الوالد بالجنس (v173): لا والدَين من نفس الجنس للابن
    const parent = await fsGet(token, "groups/" + groupId + "/persons/" + from);
    const pGender = fstr(parent, "gender");
    const existingParents = active.filter(r => r.type === "parent" && r.to === to).map(r => r.from);
    for (const pp of existingParents) {
      const ppDoc = await fsGet(token, "groups/" + groupId + "/persons/" + pp);
      const g = fstr(ppDoc, "gender");
      if (g && pGender && g === pGender) { conflict = "parent slot of this gender already taken"; break; }
    }
    // حارس الدورات: لو كان الابن أصلاً من أسلاف الوالد → دورة
    if (!conflict) {
      const seen = new Set(); let stack = [from], depth = 0;
      while (stack.length && depth < 60 && !conflict) {
        const cur = stack.pop();
        const parents = active.filter(r => r.type === "parent" && r.to === cur).map(r => r.from);
        for (const p of parents) { if (p === to) { conflict = "cycle: child is an ancestor of parent"; } if (!seen.has(p)) { seen.add(p); stack.push(p); } }
        depth++;
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
                  detail: toFsValue({ type: type, from: from, to: to, conflict: conflict }) } } },
    ]);
    return { applied: false, queued: true, reviewId: rid, reason: conflict };
  }

  const relId = crypto.randomUUID();
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + groupId + "/relations/" + relId,
      fields: { type: { stringValue: type }, from: { stringValue: from }, to: { stringValue: to },
                createdTs: { timestampValue: now }, deleted: { booleanValue: false } } } },
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
      const relId = crypto.randomUUID();
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
    // أنواع أخرى (self_duplicate …) تُغلَق فقط، دون تطبيقٍ آليّ
    await fsCommit(token, [closeReview("acknowledged")]);
    return { resolved: true, resolution: "acknowledged", kind: kind };
  }
  throw new Error("decision must be apply or reject");
}

/* ---------- 10) العمليّة: bulk.import (المالك · الرفع الأوّل) ---------- */
async function opBulkImport(uid, payload, env) {
  if (!env.SA_JSON) throw new Error("SA_JSON secret missing");
  const sa = JSON.parse(env.SA_JSON);
  const token = await getAccessToken(sa);
  const now = new Date().toISOString();
  const gid = crypto.randomUUID(); // عائلةٌ جديدة فارغة ⇒ «رفعٌ لا استبدال» مضمون
  const name = (payload && payload.name) ? String(payload.name).slice(0, 100) : "عائلتي";
  const persons = (payload && Array.isArray(payload.persons)) ? payload.persons : [];
  const relations = (payload && Array.isArray(payload.relations)) ? payload.relations : [];
  const ALLOWED = ["local_name", "gender", "kinship", "birthYear", "deathYear", "phones", "notes"];

  // خريطة المعرّفات المحلّية → Firestore
  const map = {}; let selfCount = 0; const personWrites = [];
  for (const p of persons) {
    const lid = p.localId || crypto.randomUUID();
    const fid = crypto.randomUUID(); map[lid] = fid;
    if (p.kinship === "نفسي") selfCount++;
    const f = { deleted: { booleanValue: false }, createdTs: { timestampValue: now }, updatedTs: { timestampValue: now } };
    const ftsSub = {};
    for (const k of ALLOWED) if (k in p) { f[k] = toFsValue(p[k]); ftsSub[k] = { timestampValue: now }; }
    // ⛔ healthStatus لا يُنسَخ (خارج ALLOWED) — لا يعبر القاعدة
    f.fts = { mapValue: { fields: ftsSub } };
    personWrites.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/persons/" + fid, fields: f } });
  }

  // إعادة تأصيل الصلات؛ ما سقط طرفه يُتخطّى
  let orphans = 0; const relWrites = [];
  for (const r of relations) {
    const from = map[r.fromLocalId], to = map[r.toLocalId];
    if (!from || !to) { orphans++; continue; }
    const rid = crypto.randomUUID();
    relWrites.push({ update: { name: DOC_ROOT + "/groups/" + gid + "/relations/" + rid,
      fields: { type: { stringValue: r.type }, from: { stringValue: from }, to: { stringValue: to },
                createdTs: { timestampValue: now }, deleted: { booleanValue: false } } } });
  }

  // العائلة + المالك أولاً، ثم الأشخاص، ثم الصلات (دفعاتٍ)
  await fsCommit(token, [
    { update: { name: DOC_ROOT + "/groups/" + gid,
      fields: { name: { stringValue: name }, ownerUid: { stringValue: uid }, createdTs: { timestampValue: now } } } },
    { update: { name: DOC_ROOT + "/groups/" + gid + "/members/" + uid,
      fields: { role: { stringValue: "owner" }, joinedTs: { timestampValue: now } } } },
  ]);
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
           relationsImported: relWrites.length, orphansSkipped: orphans, selfDuplicate: selfDuplicate };
}

/* ---------- المدخل ---------- */
function json(obj, status) {
  obj.ver = VER; // كلّ ردّ يحمل علامة الإصدار الحيّ
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const auth = request.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (!m) return json({ ok: false, error: "no bearer token" }, 401);
      const claims = await verifyIdToken(m[1]);
      const uid = claims.sub;

      let body = {};
      try { body = await request.json(); } catch (e) {}
      const op = body.op || "whoami";

      if (op === "whoami")
        return json({ ok: true, uid, provider: claims.firebase && claims.firebase.sign_in_provider });
      if (op === "group.create") {
        const r = await opGroupCreate(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "invite.create") {
        const r = await opInviteCreate(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      if (op === "invite.accept") {
        const r = await opInviteAccept(uid, body.payload, env);
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
        const r = await opBulkImport(uid, body.payload, env);
        return json({ ok: true, uid, op, ...r });
      }
      return json({ ok: false, error: "unknown op: " + op }, 400);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 401);
    }
  },
};
