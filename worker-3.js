/* ============================================================
   worker.js — سوا · applyEdit (v1: التحقّق من الهويّة)
   ------------------------------------------------------------
   يعمل على Cloudflare Workers (مجاناً، بلا فوترة).
   v1: يتحقّق من Firebase ID token ويردّ بـ uid.
   v2 لاحقاً: يكتب إلى Firestore بمفتاح خدمة (group.create …).

   النشر: dash.cloudflare.com → Workers & Pages → Create →
   Create Worker → Deploy → Edit code → الصق هذا → Deploy.
   ============================================================ */

const PROJECT_ID = "sawa-test-9770f";
const ISS = "https://securetoken.google.com/" + PROJECT_ID;
const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

let jwkCache = null, jwkAt = 0;
async function getKeys() {
  const now = Date.now();
  if (jwkCache && now - jwkAt < 3600000) return jwkCache;
  const res = await fetch(JWK_URL);
  const data = await res.json();
  const map = {};
  for (const k of data.keys) map[k.kid] = k;
  jwkCache = map; jwkAt = now;
  return map;
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlStr(s) { return new TextDecoder().decode(b64urlBytes(s)); }

async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("bad token format");
  const header = JSON.parse(b64urlStr(parts[0]));
  const payload = JSON.parse(b64urlStr(parts[1]));
  if (header.alg !== "RS256") throw new Error("alg");
  const jwk = (await getKeys())[header.kid];
  if (!jwk) throw new Error("unknown kid");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), signed
  );
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error("aud mismatch");
  if (payload.iss !== ISS) throw new Error("iss mismatch");
  if (payload.exp < now) throw new Error("token expired");
  if (!payload.sub) throw new Error("no sub");
  return payload;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const auth = request.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (!m) return json({ ok: false, error: "no bearer token" }, 401);
      const c = await verifyIdToken(m[1]);
      return json({
        ok: true,
        uid: c.sub,
        provider: c.firebase && c.firebase.sign_in_provider,
        aud: c.aud,
      });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 401);
    }
  },
};
