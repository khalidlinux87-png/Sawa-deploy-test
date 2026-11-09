// C271 (v126): مواعيد صلة الرحم (kinPlan · kinItems · kinBody) + قاعدة «الحيّ» (selfDeceasedRule) من worker-3.js — دوالّ نقيّة بلا Firestore.
// الاستعمال: node kin.test.js
const src = require("fs").readFileSync(__dirname + "/worker-3.js", "utf8");
const slice = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error("marker missing: " + from); return src.slice(a, b); };
const { kinPlan, kinItems, kinBody, kinSlot } = new Function(slice("const KIN_DAY", "function kinDocJs") + "; return { kinPlan, kinItems, kinBody, kinSlot };")();
const { selfDeceasedRule } = new Function(slice("const SELF_KIN", "async function opPersonSet") + "; return { selfDeceasedRule };")();

let ok = 0, bad = 0;
const check = (cond, name, got) => { if (cond) ok++; else { bad++; console.error("✗", name, got === undefined ? "" : JSON.stringify(got)); } };
const H = 3600000, D = 24 * H;
const iso = (t) => new Date(t).toISOString();

// الخرطوم UTC+2 ⇒ getTimezoneOffset = -120 · الساعة المختارة 18:00 محلّيّاً = 16:00Z
const tz = -120, hour = 18;
const now = Date.parse("2026-11-08T10:00:00Z");   // 12:00 محلّيّاً
const today18 = Date.parse("2026-11-08T16:00:00Z"), tomorrow18 = today18 + D;

// ١) تواصلت اليوم ⇒ «يوميّاً» يحين غداً 18:00
{
  const r = kinPlan({ on: true, hour, tz, items: [{ id: "g:a", n: "أحمد", e: 1, l: now - 2 * H }], sent: {} }, now);
  check(r.due.length === 0 && r.rq === tomorrow18, "daily: next is tomorrow at the chosen hour", { due: r.due.length, rq: iso(r.rq) });
}
// ٢) متأخّر أصلاً ⇒ أوّل «ساعة» قادمة اليوم 18:00 (لا فوراً في منتصف النهار)
{
  const r = kinPlan({ on: true, hour, tz, items: [{ id: "g:b", n: "فاطمة", e: 7, l: now - 8 * D }], sent: {} }, now);
  check(r.due.length === 1 && r.rq === today18, "overdue weekly: fires at today's slot", { due: r.due.length, rq: iso(r.rq) });
}
// ٣) في موعد التشغيل: كلّ من حان معاً، وبعد الإرسال يبدأ العدّ من جديد
{
  const at = today18 + 30000;
  const doc = { on: true, hour, tz, items: [{ id: "g:b", n: "فاطمة", e: 7, l: now - 8 * D }, { id: "g:c", n: "يحيى", e: 2, l: now - 3 * D }, { id: "g:d", n: "علي", e: 10, l: now - D }], sent: {} };
  const r1 = kinPlan(doc, at);
  check(r1.due.map((x) => x.n).join(",") === "فاطمة,يحيى", "slot: due list", r1.due.map((x) => x.n));
  r1.due.forEach((x) => { doc.sent[x.id] = at; });
  const r2 = kinPlan(doc, at);
  check(r2.due.length === 0 && r2.rq === today18 + 2 * D, "after sending: every-2-days returns in 2 days", { due: r2.due.length, rq: iso(r2.rq) });
}
// ٤) مدّةٌ مخصّصة (5 أيّام) بلا تذكيرٍ سابق
{
  const l = Date.parse("2026-11-05T09:00:00Z");
  const r = kinPlan({ on: true, hour, tz, items: [{ id: "g:e", n: "سعاد", e: 5, l }], sent: {} }, now);
  check(r.rq === Date.parse("2026-11-10T16:00:00Z"), "custom 5 days: day of (l + 5) at the chosen hour", iso(r.rq));
}
// ٥) التذكير لا يعيد قريباً سجّلتَ تواصلك معه بعد التذكير
{
  const r = kinPlan({ on: true, hour, tz, items: [{ id: "g:a", n: "أحمد", e: 3, l: now }], sent: { "g:a": now - 5 * D } }, now);
  check(r.due.length === 0 && r.rq === Date.parse("2026-11-11T16:00:00Z"), "contact after reminder resets the interval", iso(r.rq));
}
// ٦) مطفأ أو فارغ ⇒ لا موعد
check(kinPlan({ on: false, hour, tz, items: [{ id: "x", e: 1, l: 0 }] }, now).rq === 0, "off ⇒ rq 0");
check(kinPlan({ on: true, hour, tz, items: [] }, now).rq === 0, "no items ⇒ rq 0");
// ٧) الساعة بعد مرورها اليوم ⇒ غداً
check(kinSlot(today18 + 60000, hour, tz) === tomorrow18 && kinSlot(today18 - 60000, hour, tz) === today18, "kinSlot rolls to tomorrow after the hour");
// ٨) تنظيف المدخلات
{
  const it = kinItems([{ id: "a", n: "<b>x</b>", e: 3, l: now }, { id: "a", e: 2, l: now }, { id: "b", e: 0 }, { id: "c", e: 400 }, { id: "", e: 2 }, { id: "d", e: 1, l: now + 30 * D }], now);
  check(it.length === 2 && it[0].n === "bx/b" && it[1].id === "d" && it[1].l === now, "kinItems: dedupe, range 1–365, strip <>, future l clamped", it);
}
// ٩) نصّ الإشعار
check(kinBody([{ n: "أحمد" }], "ar") === "حان موعد التواصل مع أحمد", "body: one");
check(kinBody([{ n: "أحمد" }, { n: "فاطمة" }], "ar") === "حان موعد التواصل مع أحمد وفاطمة", "body: two");
check(kinBody([{ n: "A" }, { n: "B" }, { n: "C" }, { n: "D" }], "en") === "Time to reach out to A, B and 2 more", "body: many (en)");

// ١٠) قاعدة «الحيّ»
check(/not allowed/.test(selfDeceasedRule({ kinship: "نفسي", alive: false }) || ""), "owner self cannot be deceased");
check(/not allowed/.test(selfDeceasedRule({ kinship: "الأخ", alive: false, claimedByCaller: true }) || ""), "caller's own linked profile cannot be deceased");
check(selfDeceasedRule({ kinship: "الجد", alive: false }) === null, "a grandfather can be deceased");
check(selfDeceasedRule({ kinship: "نفسي", alive: true }) === null, "self alive is fine");

console.log((bad ? "✗" : "✓") + " kin + self-alive: " + ok + " passed, " + bad + " failed");
process.exit(bad ? 1 : 0);
