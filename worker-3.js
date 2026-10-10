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

const VER = "v14-features";      // علامة الإصدار — تظهر في كلّ ردّ
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
      fields: { role: { stringValue: grant }, joinedTs: { timestampValue: now },
                invitedBy: { stringValue: invitedBy } } } },
    indexWrite(uid, groupId, gname, grant, now),
  ]);
  return { groupId: groupId, role: grant, name: gname };
}

/* يتحقّق أنّ المستخدم محرِّر/مالك في العائلة */
async function requireEditor(token, groupId, uid) {
  const me = await fsGet(token, "groups/" + groupId + "/members/" + uid);
  const role = fstr(me, "role");
  if (role !== "owner" && role !== "editor") throw new Error("not allowed to edit");
  return role;
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
  if (["parent", "spouse", "ex_spouse", "sibling"].indexOf(type) < 0) throw new Error("bad relation type");
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
      for (const k of ALLOWED) if (k in vals) { f[k] = toFsValue(vals[k]); mask.push(k); }
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
async function opBulkImport(uid, payload, env) {
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
  // الحقول الفعليّة في التطبيق. ⛔ status_detail (الحالة الصحّية) و healthStatus
  // و photo (حجمها) لا تُخزَّن على الخادم أبداً — ليست في القائمة فتُتجاهَل.
  const ALLOWED = ["local_name", "gender", "kinship", "proximity", "birthYear", "birthday", "alive",
                   "death_date", "deathYear", "contacts", "phones", "notes", "motherId",
                   "status_detail", "noChildren"];

  // خريطة المعرّفات المحلّية → الخادم. مع حفظ المعرّفات: fid = lid (لا تبديل).
  const map = {}; let selfCount = 0; const personWrites = [];
  for (const p of persons) {
    const lid = p.localId || crypto.randomUUID();
    const fid = lid; map[lid] = fid;
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
    const rid = (r.localId && String(r.localId)) || crypto.randomUUID();
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
        fields: { role: { stringValue: "owner" }, joinedTs: { timestampValue: now } } } },
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
    const ps = await fsList(token, "groups/" + gid + "/persons");
    const personCount = ps.filter(x => !fbool(x, "deleted")).length;
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
async function opAccountAdopt(uid, payload, env) {
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
      fields: { role: { stringValue: role }, joinedTs: { timestampValue: now },
                adoptedFrom: { stringValue: fromUid } } } });
    writes.push(indexWrite(uid, gid, fstr(g, "name"), keep ? fstr(mine, "role") : role, now));
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
  if (typeof data !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(data)) throw new Error("bad image");
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
  await requireEditor(token, groupId, uid);
  const fields = (payload && payload.fields) || {};
  const ALLOWED = ["personId", "type", "title", "desc", "dateTimestamp"];
  const f = { updatedTs: { timestampValue: new Date().toISOString() }, by: { stringValue: uid } };
  for (const k of ALLOWED) if (k in fields) f[k] = toFsValue(fields[k]);
  await fsCommit(token, [{ update: { name: DOC_ROOT + "/groups/" + groupId + "/events/" + eid, fields: f } }]);
  return { eventId: eid, saved: true };
}
async function opEventDelete(uid, payload, env) {
  const token = await getAccessToken(JSON.parse(env.SA_JSON));
  const groupId = payload && payload.groupId, eid = payload && payload.eventId;
  if (!segOk(groupId) || !segOk(eid)) throw new Error("groupId/eventId required");
  await requireEditor(token, groupId, uid);
  await fsCommit(token, [{ delete: DOC_ROOT + "/groups/" + groupId + "/events/" + eid }]);
  return { eventId: eid, deleted: true };
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
        const r = await opAccountAdopt(uid, body.payload, env);
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
      return json({ ok: false, error: "unknown op: " + op }, 400);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 401);
    }
  },
};
