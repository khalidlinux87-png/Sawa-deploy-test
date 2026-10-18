/* ============================================================
   sawa-chat.js — المحادثات والحضور وجهات الاتّصال (خطّة CHAT.md)
   ------------------------------------------------------------
   C1: جهات الاتّصال الحقيقيّة (أعضاء عائلاتي + من أضفتهم برابطٍ شخصيّ)،
       والحضور «متّصل الآن / آخر ظهور» عبر Realtime Database.
   يعتمد على: firebase (compat: app/auth/database) · SawaSync (call/toast/onReady).
   الكتابة الدائمة عبر الـWorker؛ الحضور يكتبه الجهاز مباشرةً في status/{uid}
   (القواعد: صاحبه يكتب، ومن في acl/{uid} يقرأ — الـWorker يكتب acl).
   ⛔ لا تستعمل هنا اسماً عامّاً قد تعرّفه sawa-app (Image, Link, Phone…) — انظر BUILD.md.
   ============================================================ */
// P2: العنوان الرسميّ لسوا = www.sawaaap.com — من يفتح عنواناً قديماً أو بديلاً يُحوَّل فوراً مع الرابط نفسه (?code= ?room= …)
//     (Netlify القديم · sawaap.pages.dev · sawaaap.com بلا www). نسخ المعاينة ‎*.sawaap.pages.dev‎ والتجربة المحلّيّة لا تُحوَّل.
(function () {
  try {
    var h = location.hostname;
    if (/\.netlify\.app$/i.test(h) || /^sawaap\.pages\.dev$/i.test(h) || /^sawaaap\.com$/i.test(h)) {
      location.replace("https://www.sawaaap.com" + location.pathname + location.search + location.hash);
    }
  } catch (e) {}
})();
(function (global) {
  "use strict";
  var VERSION = "c84";
  var state = { uid: null, me: null, people: [], presence: {}, loaded: false, loading: false, error: null };
  var app = null, waiters = [], presenceRefs = {}, myStatusRef = null, connRef = null, authUnsub = null;

  function isAr() { try { return (localStorage.getItem("sawaLang") || "ar") === "ar"; } catch (e) { return true; } }
  function L(ar, en) { return isAr() ? ar : en; }
  function S() { return global.SawaSync; }
  function toast(m) { try { S().toast(m); } catch (e) {} }
  function call(op, payload) { return S().call(op, payload || {}); }
  function log() { try { console.log.apply(console, ["[sawa-chat]"].concat([].slice.call(arguments))); } catch (e) {} }
  function db() { try { return global.firebase && firebase.database ? firebase.database() : null; } catch (e) { return null; } }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  // C13c: حسابي يظهر فوراً من آخر نسخةٍ محفوظة — قبل أن تجهز هويّة Firebase وردّ الخادم (كانت «حسابي» تعرض
  //       «مستخدم سوا +249 9X…» ثوانيَ فتبدو نسخةً قديمة). onUid يتحقّق من الهويّة ويمسحها إن اختلفت.
  (function () { var c = lsGet("sawa_people_cache", null); if (c && c.uid && c.me) { state.me = c.me; state.people = c.people || []; state.cachedUid = c.uid; } })();
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // C39: تثبيت التطبيق على الشاشة الرئيسيّة — نلتقط beforeinstallprompt (Chrome/Edge/Samsung على أندرويد) ونحتفظ به لزرّ «تثبيت»
  var instPrompt = null;
  try {
    global.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); instPrompt = e; try { global.dispatchEvent(new CustomEvent("sawa-install-state")); } catch (x) {} });
    global.addEventListener("appinstalled", function () { instPrompt = null; lsSet("sawa_installed", Date.now()); try { global.dispatchEvent(new CustomEvent("sawa-install-state")); } catch (x) {} });
  } catch (e) {}
  // C72: داخل تطبيق أندرويد الأصليّ (WebView + SawaNativeBridge) — الإشعارات عبر FCM الأصليّ لا Web Push
  function NB() { try { return global.SawaNativeBridge || null; } catch (e) { return null; } }
  // C84: WebView في تطبيق أندرويد لا يعرف navigator.share ⇒ نوصله بقائمة المشاركة الأصليّة (واتساب، تيليجرام…)
  try {
    if (NB() && NB().share && global.navigator && !global.navigator.share) {
      global.navigator.share = function (d) {
        d = d || {};
        var parts = [d.text, d.url].filter(function (x) { return x; });
        if (d.url && d.text && String(d.text).indexOf(d.url) >= 0) parts = [d.text];
        if (!parts.length) return Promise.reject(new TypeError("nothing to share"));
        try { NB().share(d.title || "سوا", parts.join("\n")); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
      };
    }
  } catch (e) {}
  // C73: نداءٌ للجسر الأصليّ ينتظر ردّه عبر __sawaNativeCb (السجلّ مشترك مع sawa-sync)
  function nativeAsk(method, args, ms) {
    return new Promise(function (res) {
      var c = global.__sawaNatCbs = global.__sawaNatCbs || {};
      if (!global.__sawaNativeCb) global.__sawaNativeCb = function (id, r) { var f = c[id]; delete c[id]; if (f) f(r || {}); };
      var id = method + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      var to = setTimeout(function () { delete c[id]; res({ ok: false, error: "timeout" }); }, ms || 120000);
      c[id] = function (r) { clearTimeout(to); res(r || {}); };
      try { var b = NB(), a = args || []; if (a.length === 0) b[method](id); else if (a.length === 1) b[method](a[0], id); else b[method](a[0], a[1], id); } catch (e) { clearTimeout(to); delete c[id]; res({ ok: false, error: String(e) }); }
    });
  }
  function swDispatch(msg) {   // يمرّر رسالةً كأنّها من عامل الخدمة (المستمعون نفسهم في sawa-chat و sawa-rtc)
    try { if (global.navigator && navigator.serviceWorker && navigator.serviceWorker.dispatchEvent) { navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: msg })); return true; } } catch (e) {}
    return false;
  }
  global.__sawaNativePush = function (j) { try { var d = typeof j === "string" ? JSON.parse(j) : j; if (d) swDispatch({ type: "sawa-push", data: d }); } catch (e) {} };
  // رابطٌ وصل التطبيقَ وهو مفتوح (نقر إشعار/ردّ على مكالمة/رابط سوا) ⇒ نعالجه في مكانه بلا إعادة تحميل
  global.__sawaNativeOpen = function (url) {
    try {
      var u = new URL(url, global.location.href), p = u.searchParams, d = null;
      if (p.get("call")) d = { t: "call", call: p.get("call"), answer: p.get("answer") === "1" ? 1 : 0 };
      else if (p.get("room")) d = { room: p.get("room") };
      else if (p.get("chat")) d = { cid: p.get("chat") };
      else if (p.get("requests")) d = { t: "req" };
      else if (p.get("contact")) return false;   // دعوة: تحميلٌ كامل يعالجها
      if (d) return swDispatch({ type: "sawa-open", data: d });
      return true;
    } catch (e) { return false; }
  };
  var natTokWait = [];
  global.__sawaNativeToken = function (tok) {
    var w = natTokWait; natTokWait = []; w.forEach(function (f) { try { f(tok); } catch (e) {} });
    // رمزٌ جديد من أندرويد (تجديد) ⇒ تسجيلٌ فوريّ
    try { if (tok && state.uid && pushState() === "granted") registerToken(tok).catch(function () {}); } catch (e) {}
  };
  var natPermWait = [];
  global.__sawaNativePerm = function (st) { var w = natPermWait; natPermWait = []; w.forEach(function (f) { try { f(st); } catch (e) {} }); emitPush(); };
  function isStandalone() {
    if (NB()) return true;
    try { if (global.matchMedia && global.matchMedia("(display-mode: standalone)").matches) return true; } catch (e) {}
    try { if (global.navigator.standalone === true) return true; } catch (e) {}
    try { if (String(document.referrer || "").indexOf("android-app://") === 0) return true; } catch (e) {}
    return false;
  }
  // installed · ios-safari · ios-other · android-prompt · android-manual · desktop
  function installState() {
    if (isStandalone()) return "installed";
    var ua = ""; try { ua = navigator.userAgent || ""; } catch (e) {}
    var ios = /iPhone|iPad|iPod/.test(ua); try { if (!ios && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ios = true; } catch (e) {}
    if (ios) return (/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA/.test(ua)) ? "ios-safari" : "ios-other";
    if (!/Android/.test(ua)) return "desktop";
    return instPrompt ? "android-prompt" : "android-manual";
  }
  function installable() { var st = installState(); return st !== "installed" && st !== "desktop"; }
  function installNow() {   // أندرويد مع prompt: يفتح مربّع التثبيت الأصليّ
    var e = instPrompt; if (!e) return Promise.resolve("none");
    try { e.prompt(); } catch (x) { return Promise.resolve("none"); }
    return (e.userChoice || Promise.resolve({ outcome: "dismissed" })).then(function (r) { var out = r && r.outcome === "accepted" ? "accepted" : "dismissed"; if (out === "accepted") { instPrompt = null; lsSet("sawa_installed", Date.now()); } return out; }).catch(function () { return "dismissed"; });
  }
  // خطوات التثبيت اليدويّ لكلّ منصّة
  function installSteps(st) {
    if (st === "ios-safari" || st === "ios-other") return [
      ["share", L("اضغط زرّ المشاركة في شريط Safari السفليّ", "Tap the Share button in Safari's bottom bar")],
      ["plus", L("مرّر في القائمة واختر «إضافة إلى الشاشة الرئيسية»", "Scroll and choose “Add to Home Screen”")],
      ["check", L("اضغط «إضافة» في أعلى الشاشة", "Tap “Add” at the top")]];
    return [
      ["menu", L("اضغط القائمة ⋮ في أعلى المتصفّح", "Tap the ⋮ menu at the top of the browser")],
      ["plus", L("اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»", "Choose “Install app” or “Add to Home screen”")],
      ["check", L("اضغط «تثبيت»", "Tap “Install”")]];
  }

  // ---------- ربط التطبيق ----------
  function bindApp(fns) {
    app = fns || null;
    var w = waiters; waiters = [];
    w.forEach(function (f) { try { f(); } catch (e) {} });
    publish();
    try { if (state.uid) { publishChats(); Object.keys(days).forEach(publishMessages); } } catch (e) {}
  }
  function whenApp(f) { if (app) f(); else waiters.push(f); }

  // ---------- جهات الاتّصال ----------
  // الشكل الذي يراه التطبيق: { id: uid, uid, name, anon, families:[{groupId,name}], via:[…], online, lastSeen, onSawa:true }
  // التسمية: اسمٌ أختاره أنا لجهة الاتّصال (يظهر لي وحدي، ويتزامن بين أجهزتي) ← اسمه في سوا ← «ضيف · رمز» يميّز الضيوف
  function guestTag(uid) { var t = String(uid || "").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase(); return t || "؟"; }
  function nickOf(uid) { try { return (prefs && prefs.nick && prefs.nick[uid]) || null; } catch (e) { return null; } }
  function displayName(p) {
    return nickOf(p.uid) || p.name || (p.anon ? L("ضيف · ", "Guest · ") + guestTag(p.uid) : L("عضو", "Member") + " · " + guestTag(p.uid));
  }
  // ---------- C25: صور الحسابات — avatars/{uid} في Firestore (يكتبها الخادم)، تُقرأ على دفعاتٍ وتُخزَّن ١٢ ساعة ----------
  var AVK = "sawa_avatars", avCache = null, avWant = {}, avT = null, avFetching = {};
  function avAll() { if (!avCache) { avCache = lsGet(AVK, {}); if (!avCache || typeof avCache !== "object") avCache = {}; } return avCache; }
  function avSave() { var all = avAll(), ks = Object.keys(all); if (ks.length > 400) { ks.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); }); ks.slice(0, ks.length - 400).forEach(function (k) { delete all[k]; }); } lsSet(AVK, all); }
  function photoOf(uid) {
    if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(String(uid))) return null;
    var e = avAll()[uid], fresh = e && Date.now() - (e.at || 0) < 12 * 3600000;
    if (!fresh && !avFetching[uid]) { avWant[uid] = 1; if (!avT) avT = setTimeout(avFlush, 60); }
    return e && e.d ? e.d : null;
  }
  function avFlush() {
    avT = null;
    var d = fsdb(), ids = Object.keys(avWant).filter(function (u) { return !avFetching[u]; }).slice(0, 30); avWant = {};
    if (!d || !ids.length || !state.uid) return;
    ids.forEach(function (u) { avFetching[u] = 1; });
    var chunks = []; for (var i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    Promise.all(chunks.map(function (ch) {
      var q; try { q = d.collection("avatars").where(firebase.firestore.FieldPath.documentId(), "in", ch).get(); } catch (e) { q = Promise.reject(e); }
      return q.then(function (snap) {
        var got = {}; snap.forEach(function (doc) { var x = doc.data() || {}; if (typeof x.d === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(x.d) && x.d.length <= 20000) got[doc.id] = x.d; });
        var all = avAll(), now = Date.now();
        ch.forEach(function (u) { all[u] = { d: got[u] || null, at: now }; });
      }, function (e) { log("avatars:", e && e.code); var all = avAll(), now = Date.now(); ch.forEach(function (u) { all[u] = all[u] || { d: null, at: now - 11 * 3600000 }; }); });
    })).then(function () { ids.forEach(function (u) { delete avFetching[u]; }); avSave(); avChanged(); });
  }
  function avChanged() { publish(); publishChats(); Object.keys(days).forEach(publishMessages); try { if (app && app.setMyProfile) app.setMyProfile(profile()); } catch (e) {} try { global.dispatchEvent(new CustomEvent("sawa-avatars")); } catch (e) {} }
  function setMyPhoto(dataUrl) {   // null ⇒ إزالة
    return call("profile.set", { photo: dataUrl || null }).then(function () {
      var all = avAll(); all[state.uid] = { d: dataUrl || null, at: Date.now() }; avSave(); avChanged();
    });
  }
  // صورةٌ صغيرة مربّعة (١٢٨px, JPEG) ≤ ٢٠ ألف حرف
  function squareThumb(blob) {
    return loadImg(blob).then(function (r) {
      var img = r.img, w = img.naturalWidth, h = img.naturalHeight, m = Math.min(w, h), sizes = [160, 128, 96, 72], qs = [0.8, 0.72, 0.62, 0.5];
      for (var i = 0; i < sizes.length; i++) {
        var c = document.createElement("canvas"); c.width = c.height = sizes[i];
        var ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, (w - m) / 2, (h - m) / 2, m, m, 0, 0, c.width, c.height);
        var du = c.toDataURL("image/jpeg", qs[i]); if (du.length <= 20000) { URL.revokeObjectURL(r.url); return du; }
      }
      URL.revokeObjectURL(r.url); throw new Error("too big");
    });
  }
  function pickPhoto() {
    return new Promise(function (res) {
      var inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
      inp.onchange = function () { var f = inp.files && inp.files[0]; res(f || null); };
      inp.click();
    });
  }
  function decorate(p) {
    var pr = state.presence[p.uid] || null;
    return { id: p.uid, uid: p.uid, name: displayName(p), realName: p.name || null, nick: nickOf(p.uid), anon: !!p.anon, tag: guestTag(p.uid), photo: photoOf(p.uid),
             families: p.families || [], via: p.via || [], onSawa: true, phone: p.phone || "",
             online: !!(pr && pr.state === "online"), lastSeen: pr && pr.ts ? pr.ts : null };
  }
  function contacts() {
    return state.people.map(decorate).sort(function (a, b) { return a.name.localeCompare(b.name, "ar"); });
  }
  var pubTimer = null;
  function publish() {
    if (!app) return;
    if (pubTimer) return;
    pubTimer = setTimeout(function () {
      pubTimer = null;
      var list = contacts();
      try { if (app.setPeople) app.setPeople(list); } catch (e) {}
      // واجهاتٌ قديمة تعرف الأسماء فقط (نقطة «متّصل» في قائمة المحادثات) — حتّى C2
      try { if (app.setOnlineContacts) app.setOnlineContacts(list.filter(function (c) { return c.online; }).map(function (c) { return c.name; })); } catch (e) {}
      try { if (app.setMyProfile && state.me) app.setMyProfile(profile()); } catch (e) {}
    }, 60);
  }
  function applyPeople(b) {
    state.me = b.me || null; state.people = b.people || []; state.loaded = true; state.error = null;
    maybeAskName();
    lsSet("sawa_people_cache", { uid: state.uid, me: state.me, people: state.people });
    watchPresence();
    publish();
  }
  function refresh() {
    if (!state.uid || state.loading) return Promise.resolve(contacts());
    state.loading = true;
    return call("people.list", {}).then(function (b) {
      applyPeople(b);
      return contacts();
    }).catch(function (e) {
      state.error = (e && e.message) || String(e); log("people.list:", state.error);
      return contacts();
    }).then(function (r) { state.loading = false; return r; });
  }

  // ---------- الملفّ الشخصيّ: اسم «سوا» + رقم الهاتف (غير موثّق حتّى الإطلاق) ----------
  function profile() {
    var m = state.me || {};
    return { uid: state.uid, name: m.name || null, phone: m.phone || null, phoneVerified: !!m.phoneVerified, verifiedBy: m.phoneVerified ? (m.verifiedBy || "whatsapp") : null, emailVerified: !!m.emailVerified, googleName: m.googleName || null, anon: !!m.anon, photo: state.uid ? photoOf(state.uid) : null,
             code: m.code || null, findable: m.findable !== false, waReady: !!state.waReady };
  }
  function saveProfile(patch) {
    return call("profile.set", patch).then(function (b) {
      state.me = Object.assign({}, state.me || {}, { name: b.profile.name, phone: b.profile.phone, phoneVerified: !!b.profile.phoneVerified });
      // C35: اسم سوا يُكتب في حساب Firebase أيضاً (للمربوط بـGoogle أو البريد) فلا يختلف الاسمان
      if ("name" in patch && b.profile.name) { try { if (S() && S().syncAuthName) S().syncAuthName(b.profile.name); } catch (e) {} }
      lsSet("sawa_people_cache", { uid: state.uid, me: state.me, people: state.people });
      publish(); try { if (app && app.setMyProfile) app.setMyProfile(profile()); } catch (e) {}
      return profile();
    });
  }
  function editProfile(hint) {
    if (!state.uid) return false;
    var p = profile();
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;font-family:system-ui";
    ov.dir = isAr() ? "rtl" : "ltr";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;color:#1A1A2E;border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:16px 16px calc(env(safe-area-inset-bottom,0px) + 16px);box-sizing:border-box";
    function lab(t) { var l = document.createElement("div"); l.textContent = t; l.style.cssText = "font:700 12px system-ui;color:#555;margin:10px 2px 6px"; return l; }
    function inp(v, ph, ltr) { var i = document.createElement("input"); i.value = v || ""; i.placeholder = ph; i.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:12px;padding:11px 12px;font:600 15px system-ui;" + (ltr ? "direction:ltr;text-align:left" : ""); return i; }
    var h = document.createElement("div"); h.textContent = L("حسابي", "My account"); h.style.cssText = "font:800 16px system-ui;text-align:center;margin-bottom:4px";
    box.appendChild(h);
    if (typeof hint === "string" && hint) { var hh = document.createElement("div"); hh.textContent = hint; hh.style.cssText = "font:700 13px system-ui;color:#2e7d5b;text-align:center;margin:2px 0 4px"; box.appendChild(hh); }
    // C25: الصورة — تظهر لجهات اتّصالك في المحادثات والمكالمات
    var pr = document.createElement("div"); pr.style.cssText = "display:flex;align-items:center;gap:12px;margin:8px 0 2px";
    var pv = document.createElement("div"); pv.style.cssText = "width:64px;height:64px;border-radius:50%;background:#CFE5F7 center/cover no-repeat;display:flex;align-items:center;justify-content:center;font:800 26px system-ui;color:#1d5f9e;flex-shrink:0;overflow:hidden";
    var curPhoto = photoOf(state.uid), newPhoto;
    var paintPv = function () { var d = newPhoto === undefined ? curPhoto : newPhoto; pv.style.backgroundImage = d ? "url(" + d + ")" : "none"; pv.textContent = d ? "" : ((p.name || p.googleName || "؟").charAt(0)); };
    paintPv();
    var pb = document.createElement("div"); pb.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:1";
    var chg = document.createElement("button"); chg.textContent = L("📷 تغيير الصورة", "📷 Change photo"); chg.style.cssText = "padding:9px 12px;border:1.5px solid #2F80C8;border-radius:10px;background:#fff;color:#2F80C8;font:800 13px system-ui";
    var rmv = document.createElement("button"); rmv.textContent = L("إزالة الصورة", "Remove photo"); rmv.style.cssText = "padding:7px 12px;border:0;border-radius:10px;background:transparent;color:#b42318;font:700 12px system-ui";
    chg.onclick = function () { pickPhoto().then(function (f) { if (!f) return; return squareThumb(f).then(function (du) { newPhoto = du; paintPv(); }); }).catch(function () { toast(L("تعذّر قراءة الصورة", "Couldn't read the image")); }); };
    rmv.onclick = function () { newPhoto = null; paintPv(); };
    pb.appendChild(chg); pb.appendChild(rmv); pr.appendChild(pv); pr.appendChild(pb); box.appendChild(pr);
    box.appendChild(lab(L("اسمك في سوا — يراه من تتواصل معهم", "Your name in Sawa — shown to people you connect with")));
    var nIn = inp(p.name || p.googleName || "", L("مثال: خالد علي", "e.g. Khalid Ali")); box.appendChild(nIn);
    if (p.googleName && p.googleName !== p.name) { var g = document.createElement("div"); g.textContent = L("اسم حساب Google: ", "Google name: ") + p.googleName; g.style.cssText = "font:500 11px system-ui;color:#888;margin:4px 2px 0"; box.appendChild(g); }
    box.appendChild(lab(L("رقم هاتفك (اختياريّ)", "Your phone number (optional)")));
    var pIn = inp(p.phone || "", "+249 9X XXX XXXX", true); pIn.type = "tel"; box.appendChild(pIn);
    var note = document.createElement("div");
    if (p.phone && p.phoneVerified) {
      note.textContent = L("✓ رقمك موثَّق — يستطيع معارفك إيجادك به. تغييره يُلغي التوثيق.", "✓ Your number is verified — people can find you by it. Changing it removes verification.");
      note.style.cssText = "font:600 11.5px system-ui;color:#187854;background:#e8f5ee;border-radius:10px;padding:8px 10px;margin-top:8px;line-height:1.6";
    } else {
      note.textContent = L("غير موثَّق: يظهر لجهات اتّصالك فقط ولا يُبحث عنك به. وثّقه عبر واتساب في ثوانٍ من «حسابي».", "Unverified: shown to your contacts only; nobody can find you by it. Verify it via WhatsApp from «Me».");
      note.style.cssText = "font:500 11px system-ui;color:#8a6d00;background:#fff7e0;border-radius:10px;padding:8px 10px;margin-top:8px;line-height:1.6";
    }
    box.appendChild(note);
    var row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;margin-top:14px";
    var ok = document.createElement("button"); ok.textContent = L("حفظ", "Save"); ok.style.cssText = "flex:1;padding:12px;border:0;border-radius:12px;background:#2e7d5b;color:#fff;font:800 14px system-ui";
    var no = document.createElement("button"); no.textContent = L("إلغاء", "Cancel"); no.style.cssText = "flex:1;padding:12px;border:0;border-radius:12px;background:#eee;color:#333;font:700 14px system-ui";
    row.appendChild(ok); row.appendChild(no); box.appendChild(row);
    ov.appendChild(box); document.body.appendChild(ov);
    var close = function () { ov.remove(); };
    no.onclick = close; ov.onclick = function (e) { if (e.target === ov) close(); };
    ok.onclick = function () {
      var patch = {}, nm = nIn.value.replace(/\s+/g, " ").trim(), ph = pIn.value.trim();
      if (nm !== (p.name || "")) patch.name = nm;
      if (ph !== (p.phone || "")) patch.phone = ph;
      var photoChanged = newPhoto !== undefined && newPhoto !== curPhoto;
      if (!Object.keys(patch).length && !photoChanged) { close(); return; }
      if (patch.name !== undefined && patch.name.length < 2) { toast(L("اكتب اسماً من حرفين على الأقلّ", "Enter at least 2 letters")); return; }
      ok.disabled = true; ok.textContent = "…";
      (photoChanged ? setMyPhoto(newPhoto) : Promise.resolve()).then(function () { return Object.keys(patch).length ? saveProfile(patch) : null; }).then(function () { toast(L("حُفظ ✓ — يظهر لجهات اتّصالك خلال لحظات", "Saved ✓")); close(); refresh(); })
        .catch(function (e) { ok.disabled = false; ok.textContent = L("حفظ", "Save"); toast((e && e.message) || String(e)); });
    };
    setTimeout(function () { try { nIn.focus(); } catch (e) {} }, 50);
    return true;
  }

  function renameContact(uid) {
    if (!state.uid || !uid) return false;
    var p = state.people.filter(function (x) { return x.uid === uid; })[0] || { uid: uid };
    var cur = nickOf(uid) || "";
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;font-family:system-ui";
    ov.dir = isAr() ? "rtl" : "ltr";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;color:#1A1A2E;border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:16px 16px calc(env(safe-area-inset-bottom,0px) + 16px);box-sizing:border-box";
    var h = document.createElement("div"); h.textContent = L("تسمية جهة الاتّصال", "Name this contact"); h.style.cssText = "font:800 16px system-ui;text-align:center";
    var sub = document.createElement("div");
    sub.textContent = (p.name ? L("اسمه في سوا: ", "Their Sawa name: ") + p.name : (p.anon ? L("ضيف بلا اسم · الرمز ", "Unnamed guest · code ") + guestTag(uid) : "")) + " — " + L("التسمية تظهر لك وحدك", "only you see this name");
    sub.style.cssText = "font:500 12px system-ui;color:#777;text-align:center;margin:6px 0 10px";
    var i = document.createElement("input"); i.value = cur; i.placeholder = L("مثال: أحمد — زميل العمل", "e.g. Ahmed — work");
    i.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:12px;padding:11px 12px;font:600 15px system-ui";
    var row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;margin-top:12px";
    var ok = document.createElement("button"); ok.textContent = L("حفظ", "Save"); ok.style.cssText = "flex:1;padding:12px;border:0;border-radius:12px;background:#2e7d5b;color:#fff;font:800 14px system-ui";
    var clr = document.createElement("button"); clr.textContent = L("إزالة التسمية", "Clear"); clr.style.cssText = "flex:1;padding:12px;border:0;border-radius:12px;background:#eee;color:#333;font:700 14px system-ui";
    row.appendChild(ok); if (cur) row.appendChild(clr);
    box.appendChild(h); box.appendChild(sub); box.appendChild(i); box.appendChild(row); ov.appendChild(box); document.body.appendChild(ov);
    var close = function () { ov.remove(); };
    ov.onclick = function (e) { if (e.target === ov) close(); };
    var apply = function (v) {
      prefs = prefs || {}; var nk = Object.assign({}, prefs.nick || {});
      if (v) nk[uid] = v.slice(0, 40); else delete nk[uid];
      prefs.nick = nk; savePrefs({ nick: nk });
      publish(); publishChats(); Object.keys(days).forEach(publishMessages);
      toast(v ? L("حُفظت التسمية ✓", "Name saved ✓") : L("أُزيلت التسمية", "Name cleared")); close();
    };
    ok.onclick = function () { apply(i.value.replace(/\s+/g, " ").trim()); };
    clr.onclick = function () { apply(""); };
    setTimeout(function () { try { i.focus(); } catch (e) {} }, 50);
    return true;
  }
  // الضيف بلا اسم: نطلب منه اسماً مرّةً واحدة — حتّى يميّزه الآخرون
  function maybeAskName() {
    var m = state.me;
    if (!m || m.name || lsGet("sawa_name_asked", 0) || onbActive()) return;
    lsSet("sawa_name_asked", Date.now());
    setTimeout(function () { editProfile(L("اكتب اسمك ليعرفك من تتواصل معهم — بدل «ضيف»", "Add your name so people know who you are")); }, 1500);
  }

  // ---------- الحضور (Realtime Database) ----------
  function watchPresence() {
    var d = db(); if (!d) return;
    var want = {}; state.people.forEach(function (p) { want[p.uid] = 1; });
    for (var u in presenceRefs) if (!want[u]) { try { presenceRefs[u].off(); } catch (e) {} delete presenceRefs[u]; delete state.presence[u]; }
    Object.keys(want).forEach(function (u) {
      if (presenceRefs[u]) return;
      var ref = d.ref("status/" + u);
      presenceRefs[u] = ref;
      ref.on("value", function (snap) { state.presence[u] = snap.val() || null; publish(); },
        function (err) { log("presence", u, err && err.code); });   // بلا صلاحيّة بعد (acl يُكتب مع people.list)
    });
  }
  function setMine(stateName) {
    if (!myStatusRef || !global.firebase) return;
    try { myStatusRef.set({ state: stateName, ts: firebase.database.ServerValue.TIMESTAMP }); } catch (e) {}
  }
  // C50: إشارة الخادم (طلب تواصل / قبول / طلب تأكيد رقم) — كانت الطلبات لا تظهر إلا بإشعارٍ أو بعد عودةٍ من الخلفية
  var sigRef = null, sigSeen = -1;
  function startSig(uid) {
    var d = db(); if (!d) return;
    try { if (sigRef) sigRef.off(); } catch (e) {}
    sigSeen = -1;
    sigRef = d.ref("sig/" + uid);
    sigRef.on("value", function (snap) {
      var v = snap.val() || {}; var ts = Number(v.ts || 0);
      if (sigSeen < 0) { sigSeen = ts; return; }          // القيمة الأولى = الحالة الراهنة، لا حدث
      if (ts <= sigSeen) return; sigSeen = ts;
      loadRequests(); if (v.k === "reqok") refresh();
    }, function () {});
  }
  function startMyPresence(uid) {
    var d = db(); if (!d) { log("Realtime Database غير محمَّلة"); return; }
    stopMyPresence();
    startSig(uid);
    myStatusRef = d.ref("status/" + uid);
    connRef = d.ref(".info/connected");
    connRef.on("value", function (snap) {
      if (snap.val() !== true) return;
      // عند الانقطاع (إغلاق التطبيق/فقد الشبكة) يكتب الخادم «غير متّصل» بنفسه
      myStatusRef.onDisconnect().set({ state: "offline", ts: firebase.database.ServerValue.TIMESTAMP }).then(function () {
        setMine(document.visibilityState === "hidden" ? "offline" : "online");
      });
    });
  }
  function stopMyPresence() {
    try { if (sigRef) { sigRef.off(); sigRef = null; } } catch (e) {}
    try { if (connRef) connRef.off(); } catch (e) {}
    try { if (myStatusRef) { myStatusRef.onDisconnect().cancel(); setMine("offline"); } } catch (e) {}
    connRef = null; myStatusRef = null;
  }
  try {
    var hiddenAt = 0, lastRefresh = 0;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); if (myStatusRef) setMine("offline"); return; }
      if (myStatusRef) setMine("online");
      if (!state.uid) return;
      // عودةٌ بعد غيابٍ في الخلفية: اتّصال Firestore قد يكون «ميّتاً» دون أن يعلم — نعيد فتحه فوراً بدل انتظار مهلته الطويلة
      if (hiddenAt && Date.now() - hiddenAt > 15000) {
        try { var fs = firebase.firestore(); fs.disableNetwork().then(function () { return fs.enableNetwork(); }).catch(function () {}); } catch (e) {}
      }
      hiddenAt = 0;
      if (Date.now() - lastRefresh > 60000) { lastRefresh = Date.now(); refresh(); loadRequests(); }   // قائمة جهات الاتّصال: مرّة في الدقيقة على الأكثر
      if (openCid) markRead(openCid);
      unstickOutbox(); drainOutbox();
    });
    global.addEventListener("pagehide", function () { setMine("offline"); });
  } catch (e) {}

  // ---------- الرابط الشخصيّ و QR ----------
  function inviteUrl(token) { return global.location.origin + global.location.pathname.replace(/index\.html$/, "") + "?contact=" + token; }
  function createInvite() {
    return call("people.invite", {}).then(function (b) { return { token: b.token, url: inviteUrl(b.token), expiresTs: b.expiresTs }; });
  }
  function shareInvite() {
    toast(L("جارٍ إنشاء رابطك…", "Creating your link…"));
    return createInvite().then(function (inv) {
      var text = L("أضفني إلى جهات اتّصالك في سوا (الرابط صالح أسبوعاً):", "Add me as a contact on Sawa (link valid for a week):");
      if (global.navigator && navigator.share) return navigator.share({ title: "سوا", text: text, url: inv.url }).catch(function () {}).then(function () { return inv; });
      if (global.navigator && navigator.clipboard) return navigator.clipboard.writeText(text + " " + inv.url).then(function () { toast(L("نُسخ الرابط ✓", "Link copied ✓")); return inv; });
      global.prompt(L("انسخ الرابط:", "Copy the link:"), inv.url); return inv;
    }).catch(function (e) { toast(L("تعذّر إنشاء الرابط: ", "Couldn't create the link: ") + ((e && e.message) || e)); return null; });
  }
  // مكتبة QR تُحمَّل عند الحاجة فقط (cdnjs)
  var qrLib = null;
  function loadQrLib() {
    if (global.QRCode) return Promise.resolve(global.QRCode);
    if (qrLib) return qrLib;
    qrLib = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      s.onload = function () { global.QRCode ? res(global.QRCode) : rej(new Error("QR")); };
      s.onerror = function () { qrLib = null; rej(new Error(L("تعذّر تحميل أداة QR — تحقّق من الاتّصال", "Couldn't load the QR tool — check your connection"))); };
      document.head.appendChild(s);
    });
    return qrLib;
  }
  // يرسم رمز QR داخل عنصر (div) — يعيد الرابط المرسوم
  function renderQr(el, size) {
    return Promise.all([createInvite(), loadQrLib()]).then(function (r) {
      var inv = r[0], Q = r[1];
      el.innerHTML = "";
      new Q(el, { text: inv.url, width: size || 220, height: size || 220, colorDark: "#1A1A2E", colorLight: "#FFFFFF", correctLevel: Q.CorrectLevel.M });
      return inv;
    });
  }
  function tokenFrom(text) {
    if (!text) return null;
    var m = String(text).match(/[?&]contact=([A-Za-z0-9-]{8,80})/);
    if (m) return m[1];
    var t = String(text).trim();
    return /^[A-Za-z0-9-]{20,80}$/.test(t) ? t : null;
  }
  function accept(textOrToken) {
    var tok = tokenFrom(textOrToken);
    if (!tok) { toast(L("هذا ليس رابط جهة اتّصال من سوا", "That isn't a Sawa contact link")); return Promise.resolve(null); }
    return call("people.accept", { token: tok }).then(function (b) {
      if (b.self) { toast(L("هذا رابطك أنت 🙂", "That's your own link 🙂")); return null; }
      toast(L("أُضيف «" + (b.name || L("جهة اتّصال", "contact")) + "» إلى جهات اتّصالك ✓", "Added «" + (b.name || "contact") + "» to your contacts ✓"));
      return refresh().then(function () { return b; });
    }).catch(function (e) {
      var m = (e && e.message) || String(e);
      if (/expired/.test(m)) m = L("انتهت صلاحيّة الرابط — اطلب رابطاً جديداً", "The link expired — ask for a new one");
      else if (/not found/.test(m)) m = L("الرابط غير صحيح", "Invalid link");
      toast(m); return null;
    });
  }
  // C24: حظر/إلغاء حظر من جهات الاتّصال — نفس قائمة الحظر في الإعدادات (تتزامن بين أجهزتي، والخادم يمنع الرسائل والمكالمات)
  function setBlocked(uid, on) {
    if (!state.uid || !uid) return false;
    prefs = prefs || {};
    var l = (prefs.blocked || []).filter(function (u) { return u !== uid; });
    if (on) l.push(uid);
    prefs.blocked = l;
    try { if (app && app.setBlockedConversations) app.setBlockedConversations(l.map(dmWith)); } catch (e) {}
    savePrefs({ blocked: l });
    publish();
    return true;
  }
  function removeContact(uid) {
    return call("people.remove", { uid: uid }).then(function () { return refresh(); })
      .catch(function (e) { toast(L("تعذّر: ", "Failed: ") + ((e && e.message) || e)); });
  }
  // C20: مسح QR بالكاميرا — BarcodeDetector إن وُجد وعمل، وإلّا مكتبة jsQR (تُحمَّل عند الحاجة) تقرأ إطارات الكاميرا.
  //      كان يعتمد على BarcodeDetector وحده: غير موجود في متصفّحات كثيرة، وفي بعض أجهزة أندرويد موجودٌ لكنّه يفشل بصمت فلا يُقرأ شيء.
  var jsqrP = null;
  function loadJsQr() {
    if (global.jsQR) return Promise.resolve(global.jsQR);
    if (jsqrP) return jsqrP;
    // C84: عدّة مصادر — cdnjs أوّلاً (هو نفسه مصدر أداة رسم QR التي تعمل)، ثمّ jsdelivr ثمّ unpkg
    var SRC = ["https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js", "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js", "https://unpkg.com/jsqr@1.4.0/dist/jsQR.js"];
    jsqrP = new Promise(function (res, rej) {
      (function next(i) {
        if (global.jsQR) return res(global.jsQR);
        if (i >= SRC.length) { jsqrP = null; return rej(new Error(L("تعذّر تحميل قارئ QR — تحقّق من الاتّصال", "Couldn't load the QR reader — check your connection"))); }
        var sc = document.createElement("script"), t = setTimeout(function () { sc.onload = sc.onerror = null; next(i + 1); }, 12000);
        sc.src = SRC[i];
        sc.onload = function () { clearTimeout(t); global.jsQR ? res(global.jsQR) : next(i + 1); };
        sc.onerror = function () { clearTimeout(t); next(i + 1); };
        document.head.appendChild(sc);
      })(0);
    });
    return jsqrP;
  }
  var lastScanErr = "";
  function scanSupported() { return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  // C73: في تطبيق أندرويد الأصليّ نستعمل ماسح Google (أسرع ولا يطلب إذن الكاميرا)، وإن لم يتوفّر نعود إلى ماسح الصفحة
  function scanQr() {
    if (NB() && NB().scanQr) {
      return nativeAsk("scanQr", [], 180000).then(function (r) {
        if (r.ok && r.value) return r.value;
        if (r.cancelled) return null;
        // C84: لا نُخفي سبب فشل ماسح Google — غالباً أوّل استعمال (يُنزَّل في الخلفيّة) أو خدمات Google قديمة
        var er = String(r.error || "");
        log("native scan", er);
        toast(/download|unavailable|module|\b14\b/i.test(er) ? L("ماسح Google يُجهَّز لأوّل مرّة — نفتح الكاميرا الآن", "Google scanner is still downloading — using the camera")
                                                               : L("ماسح Google لم يعمل — نفتح الكاميرا", "Google scanner failed — using the camera"));
        lastScanErr = er;
        return scanQrWeb();
      });
    }
    return scanQrWeb();
  }
  function scanQrWeb() {
    if (!scanSupported()) return Promise.reject(new Error(L("الكاميرا غير متاحة في هذا المتصفّح — الصق الرابط بدلاً منه", "Camera isn't available here — paste the link instead")));
    return new Promise(function (resolve, reject) {
      var stream, done = false, det = null, detFails = 0, canvas = null, ctx = null;
      var wrap = document.createElement("div");
      wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center";
      var box = document.createElement("div"); box.style.cssText = "position:relative;width:100%;max-width:520px";
      var vid = document.createElement("video"); vid.setAttribute("playsinline", ""); vid.muted = true; vid.autoplay = true;
      vid.style.cssText = "width:100%;max-height:75vh;object-fit:cover;display:block";
      var frame = document.createElement("div");
      frame.style.cssText = "position:absolute;left:50%;top:50%;width:62%;aspect-ratio:1;transform:translate(-50%,-50%);border:3px solid rgba(255,255,255,.9);border-radius:18px;box-shadow:0 0 0 2000px rgba(0,0,0,.35)";
      box.appendChild(vid); box.appendChild(frame);
      var hint = document.createElement("div");
      hint.textContent = L("وجّه الكاميرا إلى رمز QR من سوا", "Point the camera at a Sawa QR code");
      hint.style.cssText = "color:#fff;font:700 15px system-ui;margin:14px;text-align:center";
      var btn = document.createElement("button");
      btn.textContent = L("إلغاء", "Cancel");
      btn.style.cssText = "color:#fff;background:rgba(255,255,255,.18);border:0;border-radius:12px;padding:10px 22px;font:700 14px system-ui";
      wrap.appendChild(box); wrap.appendChild(hint); wrap.appendChild(btn); document.body.appendChild(wrap);
      function finish(val, err) {
        if (done) return; done = true;
        try { stream && stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        try { wrap.remove(); } catch (e) {}
        err ? reject(err) : resolve(val);
      }
      btn.onclick = function () { finish(null); };
      try { if (global.BarcodeDetector) det = new global.BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { det = null; }
      function viaJsQr() {
        if (!global.jsQR || !vid.videoWidth) return null;
        var w = Math.min(640, vid.videoWidth), h = Math.round(vid.videoHeight * w / vid.videoWidth);
        if (!canvas) { canvas = document.createElement("canvas"); ctx = canvas.getContext("2d", { willReadFrequently: true }); }
        canvas.width = w; canvas.height = h; ctx.drawImage(vid, 0, 0, w, h);
        var r = global.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
        return r && r.data ? r.data : null;
      }
      var jsq = loadJsQr().catch(function (e) { if (!det) finish(null, e); return null; });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(function (s) {
        if (done) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s; vid.srcObject = s; return vid.play();
      }).then(function () {
        (function tick() {
          if (done) return;
          var useDet = det && detFails < 4;
          var p = useDet ? det.detect(vid).then(function (codes) { detFails = 0; return codes && codes.length && codes[0].rawValue ? codes[0].rawValue : null; }, function () { detFails++; return null; })
                         : jsq.then(function () { try { return viaJsQr(); } catch (e) { return null; } });
          p.then(function (v) { if (v) return finish(v); setTimeout(tick, useDet ? 250 : 180); });
        })();
      }).catch(function (e) { finish(null, new Error(e && e.name === "NotAllowedError" ? L("لا إذن للكاميرا — اسمح بها من إعدادات المتصفّح", "No camera permission") : L("تعذّر فتح الكاميرا", "Couldn't open the camera"))); });
    });
  }
  // C20: ما يُمسح يُوجَّه بحسب نوعه — رابط شخص · رابط مجموعة · رابط غرفة · رمز سوا (١٠ أرقام). وكلّها تسأل قبل التنفيذ.
  function routeScanned(txt) {
    var t = String(txt || "").trim(), m;
    if ((m = t.match(/[?&]group=([A-Za-z0-9-]{8,80})/))) { whenReady(function () { linkConfirm("group", m[1]); }); return "group"; }
    if ((m = t.match(/[?&]room=([A-Za-z0-9]{8})/i))) { var R = global.SawaRTC, f = R && (R.prejoin || (R._r && R._r.prejoin)); if (f) f(m[1].toUpperCase()); else toast(L("الغرف غير متاحة الآن", "Rooms unavailable")); return "room"; }
    if ((m = t.match(/[?&]code=(\d{10})/)) || (m = t.replace(/[\s-]/g, "").match(/^(\d{10})$/))) { findSheet(m[1]); return "code"; }
    var tok = tokenFrom(t);
    if (tok) { whenReady(function () { linkConfirm("contact", tok); }); return "contact"; }
    // C84: دعوة العائلة (?join=) وبقيّة روابط سوا (محادثة/طلبات…) — تُفتح كما لو ضُغط الرابط
    var u = null; try { u = new URL(t); } catch (e) {}
    if (u && /(^|\.)sawaaap\.com$/i.test(u.hostname) || (u && u.origin === global.location.origin)) {
      if (u.searchParams.get("join")) {
        if (global.confirm(L("هذا رابط دعوة للانضمام إلى عائلة في «صلة رحم». الانضمام؟", "This is a family invite. Join?"))) global.location.assign(global.location.origin + "/?join=" + encodeURIComponent(u.searchParams.get("join")));
        return "join";
      }
      if (global.__sawaNativeOpen && global.__sawaNativeOpen(u.href) && (u.searchParams.get("chat") || u.searchParams.get("call") || u.searchParams.get("requests"))) return "link";
      if (!u.search || u.search === "?") { toast(L("هذا رابط موقع سوا", "That's the Sawa website")); return "site"; }
      global.location.assign(global.location.origin + "/" + u.search); return "link";
    }
    scannedSheet(t); return null;
  }
  // رمزٌ ليس من سوا: نعرض ما قُرئ بدل رسالةٍ مبهمة (فيُعرف أنّ الكاميرا قرأت فعلاً)
  function scannedSheet(t) {
    var s = sheet(L("قُرئ الرمز", "Code scanned"));
    s.box.appendChild(note(L("هذا الرمز ليس من سوا. محتواه:", "This isn't a Sawa code. It contains:")));
    var pre = mk("div", "margin:8px 0;padding:10px;border-radius:12px;background:#f3f4f6;color:#111827;font:600 13px system-ui;direction:ltr;text-align:left;word-break:break-all;white-space:pre-wrap;max-height:40vh;overflow:auto");
    pre.textContent = t; s.box.appendChild(pre);
    var b1 = mkBtn(L("نسخ", "Copy")); b1.onclick = function () { copyText(t); s.close(); }; s.box.appendChild(b1);
    if (/^https?:\/\//i.test(t)) { var b2 = mkBtn(L("فتح الرابط", "Open link"), "primary"); b2.style.marginTop = "8px"; b2.onclick = function () { s.close(); try { if (NB() && NB().openExternal) NB().openExternal(t); else global.open(t, "_blank"); } catch (e) {} }; s.box.appendChild(b2); }
  }
  function scanAny() {
    return scanQr().then(function (txt) { return txt ? routeScanned(txt) : null; })
      .catch(function (e) { toast(((e && e.message) || String(e)) + (lastScanErr ? " · " + lastScanErr.slice(0, 80) : "")); return null; });
  }
  function scanAndAdd() { return scanAny(); }

  // رابط ?contact= في عنوان الصفحة: يُقبل بعد الدخول ثمّ يُحذف من العنوان
  function handleContactParam() {
    var tok = null;
    try { tok = new URLSearchParams(global.location.search).get("contact"); } catch (e) {}
    if (!tok) return;
    try {
      var u = new URL(global.location.href); u.searchParams.delete("contact");
      global.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
    } catch (e) {}
    whenReady(function () { afterOnb(function () { linkConfirm("contact", tok); }); });
  }
  // C14: الروابط لا تُنفَّذ وحدها — رابطٌ من غريب كان يضيفه إلى جهاتك (فيرى حالتك) أو يضمّك إلى مجموعته بلا سؤال
  function afterOnb(f) { (function w() { if (onbActive()) return setTimeout(w, 800); f(); })(); }
  function linkConfirm(kind, tok) {
    var contact = kind === "contact";
    var s = sheet(contact ? L("إضافة جهة اتّصال", "Add a contact") : L("الانضمام إلى مجموعة", "Join a group"));
    var body = mk("div", "text-align:center;margin:6px 0 4px"); s.box.appendChild(body);
    body.appendChild(note(L("جارٍ التحميل…", "Loading…")));
    function draw(b) {
      body.innerHTML = "";
      var nm = (b && b.name) || (contact ? L("مستخدم سوا", "Sawa user") : L("مجموعة", "Group"));
      var av = avatar(nm, 64); av.style.margin = "4px auto 8px"; body.appendChild(av);
      body.appendChild(mk("div", "font:800 18px system-ui", nm));
      if (!contact && b && b.count) body.appendChild(mk("div", "font:600 12.5px system-ui;color:#8796a5;margin-top:2px", L(b.count + " عضو", b.count + " members")));
      body.appendChild(note(contact
        ? L("فتحت رابطاً شخصيّاً. إن أضفته صار جهة اتّصال: يرى أنّك متّصل وآخر ظهورك، ويستطيع مراسلتك والاتّصال بك. أضِف من تعرفه فقط.",
            "You opened a personal link. Adding them lets them see when you're online and message or call you. Only add people you know.")
        : L("عند الانضمام يرى أعضاء المجموعة اسمك، ويصلك ما يُكتب فيها. انضمّ إلى المجموعات التي تعرف أصحابها فقط.",
            "Members will see your name and you'll get the group's messages. Only join groups you trust."), "#5b6b7c", "#f5f8fb"));
      var row = mk("div", "display:flex;gap:8px;margin-top:10px");
      var ok = mkBtn(contact ? L("أضِفه", "Add") : L("انضمّ", "Join"), "primary"), no = mkBtn(L("إلغاء", "Cancel"));
      ok.className = "sawa-link-ok";
      ok.onclick = function () {
        ok.disabled = true; ok.textContent = "…";
        (contact ? accept(tok) : joinGroup(tok).then(function (cid) { if (cid) whenApp(function () { setTimeout(function () { try { if (app.openChatById) app.openChatById(cid); } catch (e) {} }, 600); }); return cid; }))
          .then(function () { s.close(); });
      };
      no.onclick = function () { s.close(); };
      row.appendChild(ok); row.appendChild(no); s.box.appendChild(row);
    }
    call(contact ? "people.peek" : "group.peek", { token: tok }).then(function (b) {
      if (b.self) { s.close(); toast(L("هذا رابطك أنت 🙂", "That's your own link 🙂")); return; }
      if (b.already) { s.close(); toast(contact ? L("«" + (b.name || "") + "» في جهات اتّصالك سلفاً", "Already in your contacts") : L("أنت عضوٌ في «" + (b.name || "") + "» سلفاً", "You're already in this group"));
        if (!contact && b.cid) whenApp(function () { try { if (app.openChatById) app.openChatById(b.cid); } catch (e) {} }); return; }
      draw(b);
    }).catch(function (e) {
      var m = (e && e.message) || String(e);
      if (/unknown op|bad op/i.test(m)) { draw(null); return; }   // خادمٌ أقدم بلا معاينة: نسأل بلا اسم
      body.innerHTML = "";
      body.appendChild(note(/expired/.test(m) ? L("انتهت صلاحيّة هذا الرابط — اطلب رابطاً جديداً.", "This link has expired.")
        : /removed/.test(m) ? L("أزالك مشرفٌ من هذه المجموعة — لا تعود إلّا بإضافته.", "An admin removed you from this group.")
        : L("الرابط غير صحيح أو لم يعد صالحاً.", "This link is invalid."), "#b42318", "#fdecec"));
      var c = mkBtn(L("حسناً", "OK")); c.onclick = function () { s.close(); }; s.box.appendChild(c);
    });
  }

  // ==================================================================
  // C2: المحادثات — قائمة (chats where members ∋ أنا) · رسائل الأيّام · إرسالٌ متفائل بطابورٍ محفوظ ·
  //     وصلت/قُرئت · «يكتب…» (RTDB) · إعداداتي متزامنة بين أجهزتي
  // ==================================================================
  var chats = {}, chatsUnsub = null, dayUnsubs = {}, dayOrder = [], days = {}, pend = {}, virtualChats = {};
  var typingRefs = {}, typingNow = {}, openCid = null, prefs = null, prefsLoaded = false, prefsSent = "";
  var OUTBOX = "sawa_chat_outbox", DAYS_WINDOW = 7, MAX_DAY_LISTENERS = 6, savedAsked = false;
  function fsdb() { try { return firebase.firestore(); } catch (e) { return null; } }
  function isCloud(id) { return /^(dm_|sdm_|sv_|fam_|grp_)/.test(String(id || "")); }
  function appId(u) { return u === state.uid ? "u-1" : u; }
  function realId(u) { return u === "u-1" ? state.uid : u; }
  function newMsgId() { return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function dmWith(other) { return "dm_" + [state.uid, other].sort().join("_"); }
  function others(c) { return (c.members || []).filter(function (u) { return u !== state.uid; }); }
  function personName(u, c) {
    if (u === state.uid) return L("أنت", "You");
    var p = state.people.filter(function (x) { return x.uid === u; })[0];
    if (p) return displayName(p);
    var n = nickOf(u) || (c && c.names && c.names[u]);
    return n || L("عضو", "Member") + " · " + guestTag(u);
  }
  function typeLabel(type) {
    return type === "voice" ? L("🎤 رسالة صوتيّة", "🎤 Voice message") : type === "image" ? L("📷 صورة", "📷 Photo")
      : type === "video" ? L("🎥 فيديو", "🎥 Video") : type === "file" ? L("📎 ملفّ", "📎 File") : type === "poll" ? L("📊 استطلاع", "📊 Poll")
      : type === "contact" ? L("👤 جهة اتّصال", "👤 Contact") : type === "bill" ? L("🧾 فاتورة", "🧾 Bill") : type === "fund" ? L("💝 تبرّعات", "💝 Fundraiser")
      : type === "tasks" ? L("✅ مهامّ", "✅ Tasks") : type === "location" ? L("📍 موقع", "📍 Location") : "";
  }
  function preview(m) {
    if (!m) return "";
    if (m.del) return L("🚫 حُذفت هذه الرسالة", "🚫 This message was deleted");
    if (!m.type || m.type === "text" || m.type === "sticker") return m.text || "";
    return typeLabel(m.type) || m.text || "";
  }
  function statusOf(c, ts) {
    var os = others(c); if (!os.length) return "read";
    var reads = c.reads || {}, del = c.delivered || {};
    if (os.every(function (u) { return (reads[u] || 0) >= ts; })) return "read";
    if (os.every(function (u) { return (del[u] || 0) >= ts || (reads[u] || 0) >= ts; })) return "delivered";
    return "sent";
  }
  function unreadOf(c) {
    if (c.cid === openCid && document.visibilityState !== "hidden") return 0;
    var n = (c.cnt || 0) - ((c.readCnt || {})[state.uid] || 0);
    return n > 0 ? n : 0;
  }

  // ---------- القائمة ----------
  function startChats(uid) {
    stopChats();
    var d = fsdb(); if (!d) return;
    chatsUnsub = d.collection("chats").where("members", "array-contains", uid).onSnapshot(function (snap) {
      var next = {};
      snap.forEach(function (doc) { var x = doc.data() || {}; x.cid = doc.id; next[doc.id] = x; });
      chats = next; chatsLoaded = true;
      e2eWatch();
      for (var v in virtualChats) if (chats[v]) delete virtualChats[v];
      // C23: رسالةٌ وصلت قبل أن تصلنا وثيقة المحادثة بمفتاح مرسلها ⇒ نعيد المحاولة الآن
      if (Object.keys(plain).some(function (pk) { return plain[pk] && plain[pk].retry; })) Object.keys(days).forEach(publishMessages);
      // «وصلت»: آخر رسالةٍ من غيري أحدث ممّا سجّلتُه
      Object.keys(chats).forEach(function (cid) {
        var c = chats[cid], l = c.last;
        if (l && l.by !== state.uid && l.ts > ((c.delivered || {})[state.uid] || 0)) queueMark(cid, { d: l.ts });
      });
      if (openCid && chats[openCid]) markRead(openCid);
      if (!savedAsked && !Object.keys(chats).some(function (k) { return chats[k].type === "saved"; })) { savedAsked = true; openSaved(); }
      syncTyping();
      publishChats();
    }, function (e) { log("chats:", e && e.code); });
  }
  function stopChats() {
    try { if (chatsUnsub) chatsUnsub(); } catch (e) {}
    chatsUnsub = null;
    Object.keys(dayUnsubs).forEach(function (cid) { try { dayUnsubs[cid](); } catch (e) {} });
    dayUnsubs = {}; dayOrder = []; days = {}; chats = {};
    Object.keys(typingRefs).forEach(function (cid) { try { typingRefs[cid].off(); } catch (e) {} });
    typingRefs = {}; typingNow = {};
  }
  // ---------- رسائل محادثةٍ مفتوحة: آخر ٧ أيّامٍ فيها رسائل (وثيقةٌ لكلّ يوم) ----------
  function ensureDays(cid) {
    var d = fsdb(); if (!d || !isCloud(cid) || !state.uid) return;
    dayOrder = dayOrder.filter(function (x) { return x !== cid; }); dayOrder.push(cid);
    if (dayUnsubs[cid]) return;
    while (dayOrder.length > MAX_DAY_LISTENERS) {
      var old = dayOrder.shift();
      if (dayUnsubs[old] && old !== openCid) { try { dayUnsubs[old](); } catch (e) {} delete dayUnsubs[old]; }
    }
    var coll = d.collection("chats").doc(cid).collection("days");
    var onDays = function (snap) {
      var m = {}; snap.forEach(function (doc) { m[doc.id] = (doc.data() || {}).msgs || {}; });
      days[cid] = m;
      // ما وصل صداه يخرج من المعلّق
      if (pend[cid]) pend[cid] = pend[cid].filter(function (p) { return !findMsg(cid, p.msg.id); });
      if (cid === openCid) markRead(cid);
      publishMessages(cid);
    };
    dayUnsubs[cid] = coll.orderBy(firebase.firestore.FieldPath.documentId(), "desc").limit(DAYS_WINDOW).onSnapshot(onDays, function (e) {
      log("days", cid, e && e.code);
      // احتياط: إن طلب Firestore فهرساً للترتيب التنازليّ نقرأ آخر ١٤ يوماً تصاعديّاً (لا يحتاج فهرساً)
      if (e && e.code === "failed-precondition") {
        var from = new Date(Date.now() - 14 * 86400000), key = from.getUTCFullYear() + String(from.getUTCMonth() + 1).padStart(2, "0") + String(from.getUTCDate()).padStart(2, "0");
        dayUnsubs[cid] = coll.orderBy(firebase.firestore.FieldPath.documentId()).startAt(key).onSnapshot(onDays, function (e2) { log("days2", cid, e2 && e2.code); });
      }
    });
  }
  function findMsg(cid, id) {
    var dd = days[cid] || {};
    for (var day in dd) if (dd[day][id]) return { day: day, msg: dd[day][id] };
    return null;
  }
  function openChat(cid) {
    if (!isCloud(cid)) return;
    openCid = cid; ensureDays(cid); markRead(cid); publishChats();
  }
  function closeChat(cid) { if (!cid || openCid === cid) openCid = null; }

  // ---------- وصلت/قُرئت (مجمَّعة) ----------
  var markQ = {}, markTimer = null;
  var markFails = 0;
  function queueMark(cid, m) {
    var q = markQ[cid] || (markQ[cid] = { cid: cid });
    for (var k in m) if (m[k] != null) q[k] = Math.max(q[k] || 0, m[k]);
    if (!markTimer) markTimer = setTimeout(flushMarks, 1200);
  }
  function flushMarks() {
    markTimer = null;
    var list = Object.keys(markQ).map(function (k) { return markQ[k]; }); markQ = {};
    if (!list.length || !state.uid) return;
    call("chat.mark", { marks: list }).then(function () { markFails = 0; }).catch(function (e) {   // C14: تُعاد (حتّى ٣ مرّات) بعد ٢٠ ثانية — كانت تضيع فلا تزرقّ علامات المرسل
      log("chat.mark:", (e && e.message) || e);
      if (++markFails <= 3) setTimeout(function () { list.forEach(function (x) { queueMark(x.cid, { r: x.r, rc: x.rc, d: x.d }); }); }, 20000);
    });
  }
  function markRead(cid) {
    var c = chats[cid];
    if (!c || document.visibilityState === "hidden") return;
    var lastTs = (c.last && c.last.ts) || 0, cnt = c.cnt || 0;
    var rc = (c.readCnt || {})[state.uid] || 0, r = (c.reads || {})[state.uid] || 0;
    if (rc >= cnt && r >= lastTs) return;
    c.readCnt = Object.assign({}, c.readCnt); c.readCnt[state.uid] = cnt;
    c.reads = Object.assign({}, c.reads); c.reads[state.uid] = lastTs;
    queueMark(cid, { r: lastTs, rc: cnt, d: lastTs });
  }

  // ---------- الإرسال: متفائل + طابورٌ محفوظ (يُعاد عند عودة الشبكة) ----------
  function send(cid, text, opts) {
    opts = opts || {};
    if (!isCloud(cid) || !state.uid) return null;
    if (e2eOn(chats[cid]) && e2eState(chats[cid]) !== "ready") { toast(e2eUi(chats[cid]).title || ""); return null; }   // C23
    var msg = { id: newMsgId(), type: opts.type || "text" };
    if (text != null) msg.text = String(text);
    if (opts.reply && opts.reply.id) {
      msg.reply = { id: opts.reply.id, by: realId(opts.reply.by || null), text: String(opts.reply.text || "").slice(0, 200) };
      var rf = findMsg(cid, opts.reply.id); if (rf) msg.reply.day = rf.day;   // C14: الخادم يأخذ نصّ الاقتباس من الأصل في ذلك اليوم
    }
    if (opts.fwd) msg.fwd = true;
    if (opts.contact) msg.contact = opts.contact;
    if (opts.mentions) msg.mentions = opts.mentions;
    else if (opts.mentionsFrom && text) { var mn = mentionsIn(cid, String(text)); if (mn) msg.mentions = mn; }
    if (opts.extra) msg.extra = opts.extra;
    (pend[cid] = pend[cid] || []).push({ msg: msg, ts: Date.now(), status: "pending" });
    var ob = lsGet(OUTBOX, []); ob.push({ uid: state.uid, cid: cid, msg: msg }); lsSet(OUTBOX, ob);
    publishMessages(cid); publishChats();
    drainOutbox();
    return msg.id;
  }
  var draining = false, retryT = null;
  // حارس: إن علق طلبٌ (رغم المهلة) لا يبقى الطابور كلّه معلّقاً
  var drainAt = 0;
  function unstickOutbox() { if (draining && Date.now() - drainAt > 35000) { log("outbox: unstick"); draining = false; } }
  setInterval(function () { unstickOutbox(); if (!draining && myOutbox().length) drainOutbox(); }, 15000);
  // C14: الطابور لكلّ حساب — رسائل حسابٍ سابق على الجهاز لا تُرسل باسم الحساب الجديد. القديم بلا uid يُنسب لصاحب الجهاز الأخير.
  var FAILED = "sawa_chat_failed";
  function ownerOf(j) { if (j.uid) return j.uid; var c = lsGet("sawa_people_cache", null); return c && c.uid || null; }
  function myOutbox() { return lsGet(OUTBOX, []).filter(function (j) { return ownerOf(j) === state.uid; }); }
  // أخطاءٌ نهائيّة (رفضٌ صريح من الخادم) ⇒ «لم تُرسل» مع إعادة المحاولة. غيرها (شبكة/مهلة/خادم مشغول) ⇒ تبقى في الطابور
  var PERMANENT = /bad |not a member|too large|message id taken|only |empty message|media not uploaded|media id required|chat not found|not a contact|removed|confirm required|encrypted payload|device not bound|no key on this device|secret chat|e2e key/i;
  function drainOutbox() {
    if (draining || !state.uid) return;
    var ob = myOutbox(); if (!ob.length) return;
    draining = true; drainAt = Date.now();
    var job = ob[0];
    wireOf(job).then(function (wm) { return call("chat.send", { cid: job.cid, msg: wm }); }).then(function (b) {
      setPend(job.cid, job.msg.id, b && b.blocked ? "sent" : "sent");
      shiftOutbox(job.msg.id);
    }).catch(function (e) {
      var m = (e && e.message) || String(e);
      if (!PERMANENT.test(m)) {        // الشبكة أو الخادم مؤقّتاً: نعيد لاحقاً (أسرع في المحاولة الأولى)
        draining = false;
        if (!retryT) retryT = setTimeout(function () { retryT = null; drainOutbox(); }, 4000);
        return "stop";
      }
      setPend(job.cid, job.msg.id, "failed"); shiftOutbox(job.msg.id);
      var fl = lsGet(FAILED, []).filter(function (x) { return x.msg.id !== job.msg.id; });
      fl.push({ uid: state.uid, cid: job.cid, msg: job.msg, err: m.slice(0, 120), ts: Date.now() }); lsSet(FAILED, fl.slice(-50));
      toast(L("لم تُرسل رسالة: ", "A message wasn't sent: ") + m + L(" — اضغط ⚠ عليها لإعادة المحاولة", " — tap ⚠ to retry"));
    }).then(function (r) { if (r === "stop") return; draining = false; drainOutbox(); });
  }
  function shiftOutbox(id) { lsSet(OUTBOX, lsGet(OUTBOX, []).filter(function (x) { return x.msg.id !== id; })); }
  function setPend(cid, id, st) {
    (pend[cid] || []).forEach(function (p) { if (p.msg.id === id) p.status = st; });
    publishMessages(cid);
  }
  try { global.addEventListener("online", drainOutbox); } catch (e) {}
  function restorePending() {   // بعد إعادة الفتح: ما بقي في الطابور يظهر «قيد الإرسال»، وما رُفض «لم تُرسل» (C14: كان يختفي)
    var add = function (j, st) { if (ownerOf(j) !== state.uid) return; if (!(pend[j.cid] || []).some(function (p) { return p.msg.id === j.msg.id; })) (pend[j.cid] = pend[j.cid] || []).push({ msg: j.msg, ts: j.ts || Date.now(), status: st }); };
    lsGet(OUTBOX, []).forEach(function (j) { add(j, "pending"); });
    lsGet(FAILED, []).forEach(function (j) { add(j, "failed"); });
  }
  // C14: «لم تُرسل» ⇒ إعادة المحاولة أو الحذف
  function retryFailed(id) {
    for (var c0 in pend) { var pp = (pend[c0] || []).filter(function (p) { return p.msg.id === id && p.reupload; })[0]; if (pp) { pp.reupload(); return true; } }   // C18: وسيطٌ لم يُرفع ⇒ يُعاد رفعه
    var fl = lsGet(FAILED, []), j = fl.filter(function (x) { return x.msg.id === id && ownerOf(x) === state.uid; })[0];
    if (!j) { for (var cid in pend) (pend[cid] || []).forEach(function (p) { if (p.msg.id === id && p.status === "failed") j = { cid: cid, msg: p.msg }; }); }
    if (!j) return false;
    lsSet(FAILED, fl.filter(function (x) { return x.msg.id !== id; }));
    var ob = lsGet(OUTBOX, []); if (!ob.some(function (x) { return x.msg.id === id; })) { ob.push({ uid: state.uid, cid: j.cid, msg: j.msg }); lsSet(OUTBOX, ob); }
    setPend(j.cid, id, "pending"); drainOutbox();
    return true;
  }
  function discardFailed(id) {
    lsSet(FAILED, lsGet(FAILED, []).filter(function (x) { return x.msg.id !== id; }));
    for (var cid in pend) { var n = (pend[cid] || []).length; pend[cid] = (pend[cid] || []).filter(function (p) { return p.msg.id !== id; }); if (pend[cid].length !== n) publishMessages(cid); }
  }
  function failedSheet(id) {
    var s = sheet(L("لم تُرسل هذه الرسالة", "This message wasn't sent"));
    var j = lsGet(FAILED, []).filter(function (x) { return x.msg.id === id; })[0];
    if (j && j.err) s.box.appendChild(note(L("السبب: ", "Reason: ") + j.err, "#b42318", "#fdecec"));
    var a = mkBtn(L("إعادة الإرسال", "Send again"), "primary"); a.onclick = function () { s.close(); retryFailed(id); };
    var b = mkBtn(L("حذفها", "Delete it"), "danger"); b.style.marginTop = "8px"; b.onclick = function () { s.close(); discardFailed(id); };
    s.box.appendChild(a); s.box.appendChild(b);
  }

  // ---------- أفعال الرسالة ----------
  function patchLocal(cid, id, fn) {
    var f = findMsg(cid, id); if (!f) return null;
    days[cid][f.day] = Object.assign({}, days[cid][f.day]); days[cid][f.day][id] = fn(Object.assign({}, f.msg));
    publishMessages(cid); return f.day;
  }
  function fail(e) { toast(L("تعذّر: ", "Failed: ") + ((e && e.message) || e)); }
  function edit(cid, id, text) {
    if (e2eOn(chats[cid])) {   // C23: نصٌّ مشفّرٌ جديد للرسالة نفسها (يبقى الاقتباس)
      var f0 = findMsg(cid, id); if (!f0 || !f0.msg.enc) return;
      var old = plain[encKey(cid, f0.msg)] || {}, np = { text: String(text) }; if (old.reply) np.reply = { id: old.reply.id, by: old.reply.by || null };
      e2e.encrypt(chats[cid], id, np).then(function (en) { return call("chat.edit", { cid: cid, day: f0.day, id: id, enc: en }); }).catch(function (e) { toast(e2eErrText(e)); });
      return;
    }
    var day = patchLocal(cid, id, function (m) { m.text = text; m.edited = Date.now(); return m; });
    if (!day) return;
    call("chat.edit", { cid: cid, day: day, id: id, text: text }).catch(fail);
  }
  function deleteForAll(cid, id) {
    var day = patchLocal(cid, id, function (m) { return { id: m.id, by: m.by, ts: m.ts, type: m.type, del: true }; });
    if (!day) return;
    call("chat.delete", { cid: cid, day: day, id: id }).catch(fail);
  }
  function deleteForMe(cid, id) {
    prefs = prefs || {}; prefs.hidden = Object.assign({}, prefs.hidden); prefs.hidden[id] = 1;
    publishMessages(cid); savePrefs({ hidden: prefs.hidden });
  }
  // «حذف المحادثة» عندي: تُخفى رسائلها حتّى الآن، وتختفي من القائمة حتّى تصل رسالةٌ جديدة
  function clearChat(cid) {
    prefs = prefs || {}; prefs.cleared = Object.assign({}, prefs.cleared); prefs.cleared[cid] = Date.now();
    publishMessages(cid); publishChats(); savePrefs({ cleared: prefs.cleared });
  }
  function react(cid, id, emoji) {
    var day = patchLocal(cid, id, function (m) { m.re = Object.assign({}, m.re); if (emoji) m.re[state.uid] = emoji; else delete m.re[state.uid]; return m; });
    if (!day) return;
    call("chat.react", { cid: cid, day: day, id: id, emoji: emoji || null }).catch(fail);
  }
  function pin(cid, id) {
    var c = chats[cid]; if (!c) return;
    var next = c.pinned === id ? null : id; c.pinned = next; publishChats();
    call("chat.pin", { cid: cid, id: next }).catch(fail);
  }
  function setDisappear(cid, seconds) {
    var c = chats[cid]; if (c) { c.disappear = seconds; publishChats(); }
    return call("chat.settings", { cid: cid, disappear: seconds }).catch(fail);
  }
  function openDm(uid) {
    if (!state.uid || !uid) return Promise.resolve(null);
    var cid = dmWith(uid);
    if (!chats[cid]) virtualChats[cid] = { cid: cid, type: "dm", members: [state.uid, uid].sort(), names: {}, cnt: 0, updatedTs: Date.now(), virtual: true };
    publishChats();
    return call("chat.open", { to: uid }).then(function (b) { return b.cid; })
      .catch(function (e) { delete virtualChats[cid]; publishChats(); fail(e); return null; });
  }
  function openSaved() {
    if (!state.uid) return Promise.resolve(null);
    return call("chat.open", { saved: true }).then(function (b) { return b.cid; }).catch(function (e) { fail(e); return null; });
  }

  // ---------- «يكتب…» (Realtime Database: typing/{cid}/{uid}) ----------
  var lastTyping = {}, typingClear = {};
  function typing(cid) {
    var d = db(); if (!d || !isCloud(cid) || !state.uid) return;
    var now = Date.now();
    if (!lastTyping[cid] || now - lastTyping[cid] > 3000) {
      lastTyping[cid] = now;
      var ref = d.ref("typing/" + cid + "/" + state.uid);
      try { ref.onDisconnect().remove(); ref.set(firebase.database.ServerValue.TIMESTAMP); } catch (e) {}
    }
    clearTimeout(typingClear[cid]);
    typingClear[cid] = setTimeout(function () { lastTyping[cid] = 0; try { d.ref("typing/" + cid + "/" + state.uid).remove(); } catch (e) {} }, 5000);
  }
  function syncTyping() {
    var d = db(); if (!d) return;
    var want = Object.keys(chats).slice(0, 30);
    Object.keys(typingRefs).forEach(function (cid) { if (want.indexOf(cid) < 0) { try { typingRefs[cid].off(); } catch (e) {} delete typingRefs[cid]; delete typingNow[cid]; } });
    want.forEach(function (cid) {
      if (typingRefs[cid] || chats[cid].type === "saved") return;
      var ref = d.ref("typing/" + cid); typingRefs[cid] = ref;
      ref.on("value", function (s) { typingNow[cid] = s.val() || {}; publishTyping(); }, function () {});
    });
  }
  function typingList() {
    var now = Date.now(), out = [];
    Object.keys(typingNow).forEach(function (cid) {
      var t = typingNow[cid] || {};
      if (Object.keys(t).some(function (u) { return u !== state.uid && now - (t[u] || 0) < 8000; })) out.push(cid);
    });
    return out;
  }
  function whoTyping(cid) {
    var t = typingNow[cid] || {}, now = Date.now(), c = chats[cid];
    return Object.keys(t).filter(function (u) { return u !== state.uid && now - (t[u] || 0) < 8000; }).map(function (u) { return personName(u, c); });
  }
  var typingSig = "";
  function publishTyping() {
    var l = typingList(), sig = l.join(",");
    if (sig === typingSig || !app || !app.setTypingConversations) return;
    typingSig = sig; app.setTypingConversations(l);
  }
  setInterval(function () { if (Object.keys(typingNow).length) publishTyping(); }, 3000);

  // ---------- النشر للتطبيق ----------
  function chatList() {
    var all = Object.assign({}, virtualChats, chats), cleared = (prefs && prefs.cleared) || {};
    return Object.keys(all).map(function (k) { return all[k]; }).filter(function (c) {
      return !cleared[c.cid] || c.cid === openCid || ((c.last && c.last.ts) || 0) > cleared[c.cid] || (pend[c.cid] || []).length;
    });
  }
  function convOf(c) {
    var other = others(c)[0], l = c.last;
    var p = other && state.people.filter(function (x) { return x.uid === other; })[0];
    var pendList = pend[c.cid] || [], lp = pendList[pendList.length - 1];
    var lastMine = lp ? true : !!(l && l.by === state.uid);
    var sec = e2eOn(c);
    return {
      id: c.cid, cloud: true, kind: c.type, peerUid: other || null,
      name: c.type === "saved" ? L("رسائلي المحفوظة", "Saved messages") : personName(other, c) + (sec ? " 🔒" : ""),
      isSavedMessages: c.type === "saved", secret: sec, e2e: sec ? e2eUi(c) : null, photo: other ? photoOf(other) : null,
      lastMessage: lp ? preview(lp.msg) : sec ? secretPreview(c) : preview(l), lastFromMe: lastMine,
      lastStatus: lp ? lp.status : (l && l.by === state.uid ? statusOf(c, l.ts) : null),
      unread: unreadOf(c), updatedAt: lp ? lp.ts : (c.updatedTs || 0), pinnedMessageId: c.pinned || null,
      disappear: c.disappear || 0, online: !!(p && state.presence[other] && state.presence[other].state === "online")
    };
  }
  function groupOf(c) {
    var admins = c.admins || [], l = c.last;
    var members = (c.members || []).map(function (u) {
      return { id: appId(u), uid: u, name: u === state.uid ? L("أنت", "You") : personName(u, c), role: admins.indexOf(u) >= 0 ? "admin" : "member", photo: photoOf(u) };
    });
    var pendList = pend[c.cid] || [], lp = pendList[pendList.length - 1];
    var sec = e2eOn(c);
    var lastText = lp ? preview(lp.msg) : (l ? (l.type === "system" ? sysText({ by: l.by, extra: { ev: l.ev } }, c).replace(/«»|“”/g, "").trim() : (l.by && l.by !== state.uid ? personName(l.by, c) + ": " : "") + (sec ? secretPreview(c) : preview(l))) : (sec ? secretPreview(c) : ""));
    return { id: c.cid, cloud: true, kind: c.type, familyGroupId: c.familyGroupId || null, desc: c.desc || "", adminsOnly: !!c.adminsOnly, infoAdminsOnly: !!c.infoAdminsOnly,
      name: (c.name || L("مجموعة", "Group")) + (sec ? " 🔒" : ""), members: members, lastMessage: lastText, secret: sec, e2e: sec ? e2eUi(c) : null,
      unread: unreadOf(c), updatedAt: lp ? lp.ts : (c.updatedTs || 0), pinnedMessageId: c.pinned || null, disappear: c.disappear || 0 };
  }
  var pubChatsT = null;
  function publishChats() {
    if (!app || pubChatsT) return;
    pubChatsT = setTimeout(function () {
      pubChatsT = null;
      var list = chatList();
      var convs = list.filter(function (c) { return c.type === "dm" || c.type === "saved"; }).map(convOf)
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      var groups = list.filter(function (c) { return c.type === "family" || c.type === "group"; }).map(groupOf)
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      try { if (app.setConversations) app.setConversations(convs); } catch (e) {}
      appBadge();
      try { if (app.setGroups) app.setGroups(groups); } catch (e) {}
    }, 40);
  }
  function appMessages(cid) {
    var c = chats[cid] || virtualChats[cid] || { members: [] }, hidden = (prefs && prefs.hidden) || {};
    var clearedAt = (prefs && prefs.cleared && prefs.cleared[cid]) || 0;
    var dd = days[cid] || {}, arr = [], now = Date.now();   // C14: المؤقّتة تختفي عند انتهاء أجلها (لا تنتظر تنظيف الخادم)
    Object.keys(dd).forEach(function (day) { var mm = dd[day]; Object.keys(mm).forEach(function (id) { var m = mm[id]; if (m && !hidden[id] && (m.ts || 0) > clearedAt && !(m.exp && m.exp < now)) arr.push({ m: m, day: day }); }); });
    if (e2eOn(c)) {
      arr = arr.filter(function (x) { var m0 = x.m; return !(m0.type === "system" && m0.extra && m0.extra.ev === "e2e_rekey" && m0.by !== state.uid); });
      (lsGet(NOTES, {})[cid] || []).forEach(function (n) { if (n.ts > clearedAt) arr.push({ m: { id: n.id, by: "", ts: n.ts, type: "system", extra: { ev: "local" }, text: n.text } }); });
    }
    (pend[cid] || []).forEach(function (p) { if (!hidden[p.msg.id]) arr.push({ m: Object.assign({ by: state.uid, ts: p.ts }, p.msg), pending: p.status, progress: p.uploading ? (p.progress || 0) : null }); });
    arr.sort(function (a, b) { return (a.m.ts || 0) - (b.m.ts || 0); });
    var group = c.type === "family" || c.type === "group";
    return arr.map(function (x) {
      var m = x.m.enc && !x.m.del ? plainOf(cid, x.m) : x.m, mine = m.by === state.uid, re = m.re || {};
      var mineRe = re[state.uid], anyRe = Object.keys(re).map(function (k) { return re[k]; })[0];
      var o = { id: m.id, day: x.day || null, createdAt: m.ts, text: m.del ? L("🚫 حُذفت هذه الرسالة", "🚫 This message was deleted") : (m.text || ""),
                type: m.del ? "text" : (m.type === "text" ? undefined : m.type), deleted: !!m.del, edited: !!m.edited,
                forwarded: !!m.fwd, reaction: mineRe || anyRe || null, reactions: re, replyTo: m.reply || null,
                replyToText: m.reply ? (m.reply.missing ? L("رسالة غير متاحة", "Message unavailable") : m.reply.del ? L("🚫 رسالة محذوفة", "🚫 Deleted message") : m.reply.text) : null, contact: m.contact || null, extra: m.extra || null, cloud: true,
                starred: !!(prefs && prefs.starred && prefs.starred.some(function (s) { return s.id === m.id; })) };
      if (group) { o.senderId = appId(m.by); o.senderName = personName(m.by, c); if (o.type === undefined) o.type = "text"; if (!m.del) toolShape(m, o, c); }
      else { o.senderUserId = appId(m.by); if (m.type === "system") { o.type = "system"; o.text = sysText(m, c); } }   // C23: إشعارات المحادثة السرّيّة في المحادثة الفرديّة
      if (m.e2eErr) o.e2eErr = true;
      if (!m.del && MEDIA_TYPES.indexOf(m.type) >= 0) mediaShape(m, o, cid, mine);
      if (!m.del && m.type === "location" && m.extra) { o.type = "location"; o.lat = Number(m.extra.lat); o.lng = Number(m.extra.lng); o.acc = m.extra.acc || null; o.text = m.extra.label || ""; }
      if (mine) o.status = x.pending ? (x.pending === "failed" ? "failed" : "pending") : statusOf(c, m.ts);
      if (x.progress != null) o.uploadPct = x.progress;   // نسبة رفع الوسيط (تظهر بدل الساعة)
      return o;
    });
  }
  var pubMsgT = {};
  function publishMessages(cid) {
    if (!app || pubMsgT[cid]) return;
    pubMsgT[cid] = setTimeout(function () {
      delete pubMsgT[cid];
      var c = chats[cid] || virtualChats[cid] || {}, list = appMessages(cid);
      var group = c.type === "family" || c.type === "group";
      var setter = group ? app.setGroupMessages : app.setMessagesByConversation;
      if (setter) try { setter(function (prev) { var o = {}; for (var k in (prev || {})) if (isCloud(k)) o[k] = prev[k]; o[cid] = list; return o; }); } catch (e) {}
      publishChats();
    }, 30);
  }

  // ---------- إعداداتي في المحادثات (بين أجهزتي) ----------
  var PREF_SETTERS = { archived: "setArchivedConversations", pinned: "setPinnedConversations", muted: "setMutedConversations",
    locked: "setLockedConversationIds", folders: "setChatFolders", folderOf: "setFolderAssignments", themes: "setChatThemes",
    tones: "setConversationTones", starred: "setStarredMessages", blocked: "setBlockedConversations", broadcasts: "setBroadcastLists" };
  function loadPrefs(pre) {
    return (pre ? Promise.resolve(pre) : call("chat.prefs", {})).then(function (b) {
      prefs = b.prefs || {}; prefsLoaded = true;
      var applied = {};
      Object.keys(PREF_SETTERS).forEach(function (k) {
        if (!(k in prefs)) return;
        var v = k === "blocked" ? (prefs.blocked || []).map(dmWith) : prefs[k];
        applied[k] = v;
        try { if (app && app[PREF_SETTERS[k]]) app[PREF_SETTERS[k]](v); } catch (e) {}
      });
      prefsSent = JSON.stringify(normPrefs(applied));
      Object.keys(days).forEach(publishMessages); publishChats(); publish();   // التسميات تظهر في جهات الاتّصال
    }).catch(function (e) { log("prefs:", (e && e.message) || e); });
  }
  function normPrefs(o) {
    var out = {};
    Object.keys(PREF_SETTERS).forEach(function (k) {
      if (o[k] === undefined) return;
      if (k === "starred") { out[k] = (o.starred || []).map(function (x) { return x && (knownSecret(x.conversationId) || e2eOn(chats[x.conversationId])) ? Object.assign({}, x, { text: "🔒" }) : x; }); return; }
      out[k] = k === "blocked" ? (o.blocked || []).filter(function (id) { return /^s?dm_/.test(id); }).map(function (id) { if (/^sdm_/.test(id)) { var sc = chats[id]; return sc ? others(sc)[0] : null; } return id.slice(3).split("_").filter(function (u) { return u !== state.uid; })[0]; }).filter(Boolean)
        : o[k];
    });
    return out;
  }
  var prefsT = null, prefsPending = {};
  function savePrefs(partial) {
    Object.assign(prefsPending, partial);
    clearTimeout(prefsT);
    prefsT = setTimeout(function () {
      var set = prefsPending; prefsPending = {};
      call("chat.prefs", { set: set }).catch(function (e) { log("prefs save:", (e && e.message) || e); });
    }, 1500);
  }
  // يستدعيه التطبيق عند تغيّر أيٍّ من إعداداته (بعد التحميل الأوّل فقط — لا نكتب فوق الخادم بنسخةٍ قديمة)
  function observePrefs(appPrefs) {
    if (!prefsLoaded || !state.uid) return;
    var n = normPrefs(appPrefs || {}), sig = JSON.stringify(n);
    if (sig === prefsSent) return;
    var old = {}; try { old = JSON.parse(prefsSent || "{}"); } catch (e) {}
    var diff = {}; Object.keys(n).forEach(function (k) { if (JSON.stringify(n[k]) !== JSON.stringify(old[k])) diff[k] = n[k]; });
    prefsSent = sig;
    if (n.blocked) { prefs = prefs || {}; prefs.blocked = n.blocked; }
    if (n.starred) { prefs = prefs || {}; prefs.starred = n.starred; if (diff.starred) Object.keys(days).forEach(publishMessages); }
    if (Object.keys(diff).length) savePrefs(diff);
  }

  // ==================================================================
  // C3: المجموعات وأدواتها (استطلاع · فاتورة · تبرّعات · مهامّ) · رسائل النظام · الإشارات @ · روابط دعوة المجموعات
  // ==================================================================
  function createGroup(name, uids) {
    return call("group.new", { name: name, members: (uids || []).map(realId) }).then(function (b) {
      if (b.skipped && b.skipped.length) toast(L("لم يُضف " + b.skipped.length + " (ليسوا من جهات اتّصالك)", b.skipped.length + " not added (not your contacts)"));
      return b.cid;
    }).catch(function (e) { fail(e); return null; });
  }
  function updateGroup(cid, patch) {
    var c = chats[cid]; if (c) { Object.assign(c, patch); publishChats(); }
    return call("group.update", Object.assign({ cid: cid }, patch)).catch(fail);
  }
  function addMembers(cid, uids) { return call("group.members", { cid: cid, add: (uids || []).map(realId) }).catch(fail); }
  function removeMember(cid, uid) { return call("group.members", { cid: cid, remove: [realId(uid)] }).catch(fail); }
  function setAdmin(cid, uid, on) { return call("group.admin", { cid: cid, uid: realId(uid), admin: !!on }).catch(fail); }
  function leaveGroup(cid) { closeChat(cid); return call("group.exit", { cid: cid }).catch(fail); }
  function shareGroupInvite(cid) {
    toast(L("جارٍ إنشاء الرابط…", "Creating link…"));
    return call("group.invite", { cid: cid }).then(function (b) {
      var url = global.location.origin + global.location.pathname.replace(/index\.html$/, "") + "?group=" + b.token;
      var name = (chats[cid] && chats[cid].name) || "";
      var text = L("انضمّ إلى مجموعة «" + name + "» في سوا (صالح أسبوعاً):", "Join the «" + name + "» group on Sawa (valid for a week):");
      if (global.navigator && navigator.share) return navigator.share({ title: "سوا", text: text, url: url }).catch(function () {});
      if (global.navigator && navigator.clipboard) return navigator.clipboard.writeText(text + " " + url).then(function () { toast(L("نُسخ الرابط ✓", "Link copied ✓")); });
      global.prompt(L("انسخ الرابط:", "Copy the link:"), url);
    }).catch(fail);
  }
  function joinGroup(tok) {
    return call("group.join", { token: tok }).then(function (b) {
      toast(b.already ? L("أنت عضوٌ في «" + (b.name || "") + "» سلفاً", "You're already in «" + (b.name || "") + "»") : L("انضممت إلى «" + (b.name || "") + "» ✓", "You joined «" + (b.name || "") + "» ✓"));
      return b.cid;
    }).catch(function (e) {
      var m = (e && e.message) || String(e);
      toast(/expired/.test(m) ? L("انتهت صلاحيّة رابط المجموعة", "The group link expired") : /not found/.test(m) ? L("رابط المجموعة غير صحيح", "Invalid group link") : L("تعذّر الانضمام: ", "Couldn't join: ") + m);
      return null;
    });
  }
  // الإشارات: @الاسم في النصّ ⇒ معرّفات الأعضاء (للإشعارات في C5)
  function mentionsIn(cid, text) {
    var c = chats[cid]; if (!c || !text || text.indexOf("@") < 0) return null;
    var out = [];
    (c.members || []).forEach(function (u) {
      if (u === state.uid) return;
      var n = personName(u, c);
      if (n && text.indexOf("@" + n) >= 0) out.push(u);
    });
    return out.length ? out : null;
  }
  // أدوات المجموعة: تُرسَل رسائل بنوعٍ خاصّ، والتفاعل معها حقلٌ لكلّ شخص
  function sendPoll(cid, question, options, deadline, anonymous) {
    return send(cid, null, { type: "poll", extra: { question: String(question), options: (options || []).map(String), deadline: deadline || null, anonymous: !!anonymous } });
  }
  function toolCall(op, cid, id, extra, local) {
    var day = local ? patchLocal(cid, id, local) : (findMsg(cid, id) || {}).day;
    if (!day) { toast(L("لحظة — الرسالة لم تُحفظ بعد", "One moment — the message isn't saved yet")); return; }
    call(op, Object.assign({ cid: cid, day: day, id: id }, extra)).catch(fail);
  }
  // C16: الاستطلاع المجهول — صوتي مخزَّنٌ تحت مفتاحٍ لا يعرفه غيري؛ أعرف مفتاحي من الخادم (يُحفظ على الجهاز)
  var PKEYS = "sawa_poll_keys", pkWant = {}, pkT = null;
  function pollKey(id) { var k = lsGet(PKEYS, {}); return k[state.uid + ":" + id] || null; }
  function savePollKey(id, key) { var k = lsGet(PKEYS, {}); k[state.uid + ":" + id] = key; var ks = Object.keys(k); if (ks.length > 400) delete k[ks[0]]; lsSet(PKEYS, k); }
  function wantPollKey(cid, id) {
    if (pollKey(id) || pkWant[id]) return;
    pkWant[id] = cid;
    if (!pkT) pkT = setTimeout(function () {
      pkT = null; var by = {};
      Object.keys(pkWant).forEach(function (i) { if (pkWant[i] !== true) { (by[pkWant[i]] = by[pkWant[i]] || []).push(i); pkWant[i] = true; } });
      Object.keys(by).forEach(function (c) {
        call("chat.pollKeys", { cid: c, ids: by[c].slice(0, 50) }).then(function (b) {
          Object.keys((b && b.keys) || {}).forEach(function (i) { savePollKey(i, b.keys[i]); }); publishMessages(c);
        }).catch(function () {});
      });
    }, 300);
  }
  function vote(cid, id, idx) {
    var f = findMsg(cid, id), anon = !!(f && f.msg.extra && f.msg.extra.anonymous), key = anon ? pollKey(id) : state.uid;
    var day = key ? patchLocal(cid, id, function (m) { m.votes = Object.assign({}, m.votes); if (anon) delete m.votes[state.uid]; m.votes[key] = idx; return m; }) : (f || {}).day;
    if (!day) { toast(L("لحظة — الرسالة لم تُحفظ بعد", "One moment — the message isn't saved yet")); return; }
    call("chat.vote", { cid: cid, day: day, id: id, option: idx }).then(function (b) { if (b && b.key) { savePollKey(id, b.key); publishMessages(cid); } }).catch(fail);
  }
  function editPoll(cid, id, question, options) { toolCall("chat.pollEdit", cid, id, { question: question, options: options }); }
  function sendBill(cid, description, totalAmount, participantAmounts, splitType) {
    var c = chats[cid] || {};
    var parts = Object.keys(participantAmounts || {}).map(function (aid) { var u = realId(aid); return { uid: u, name: personName(u, c), share: Number(participantAmounts[aid]) || 0 }; });
    return send(cid, null, { type: "bill", extra: { description: String(description), totalAmount: Number(totalAmount) || 0, participants: parts, splitType: splitType || "equal" } });
  }
  function billPaid(cid, id, uid) {
    var who = realId(uid || "u-1");
    toolCall("chat.billPaid", cid, id, { uid: who }, function (m) { m.paid = Object.assign({}, m.paid); m.paid[who] = Date.now(); return m; });
  }
  function sendFund(cid, cause, goal, deadline) { return send(cid, null, { type: "fund", extra: { cause: String(cause), goal: Number(goal) || 0, deadline: deadline || null } }); }
  function contribute(cid, id, amount) {
    toolCall("chat.fund", cid, id, { amount: amount }, function (m) { m.contrib = Object.assign({}, m.contrib); var p = m.contrib[state.uid] || { amount: 0 }; m.contrib[state.uid] = { amount: p.amount + amount, ts: Date.now() }; return m; });
  }
  function sendTasks(cid, title, tasks) {
    return send(cid, null, { type: "tasks", extra: { title: String(title), tasks: (tasks || []).map(function (t) { return { id: t.id, text: t.text, assigneeId: realId(t.assigneeId), assigneeName: t.assigneeName || "", dueAt: t.dueAt || null }; }) } });
  }
  function setTask(cid, id, taskId, patch) {
    toolCall("chat.task", cid, id, Object.assign({ taskId: taskId }, patch), function (m) { m.tstate = Object.assign({}, m.tstate); m.tstate[taskId] = Object.assign({}, m.tstate[taskId], patch); return m; });
  }
  // نصّ رسائل النظام
  function sysText(m, c) {
    var ex = m.extra || {}, who = personName(m.by, c);
    var list = (ex.who || []).map(function (u) { return personName(u, c); }).join(L("، ", ", "));
    var T = {
      created: L(who + " أنشأ المجموعة «" + (ex.name || "") + "»", who + " created the group “" + (ex.name || "") + "”"),
      added: L(who + " أضاف " + list, who + " added " + list), removed: L(who + " أزال " + list, who + " removed " + list),
      left: L(who + " غادر", who + " left"), joined: L(who + " انضمّ عبر رابط الدعوة", who + " joined via the invite link"),
      admin: L(who + " جعل " + list + " مشرفاً", who + " made " + list + " an admin"), unadmin: L(who + " أزال إشراف " + list, who + " removed " + list + " as admin"),
      renamed: L(who + " غيّر الاسم إلى «" + (ex.name || "") + "»", who + " renamed the group to “" + (ex.name || "") + "”"),
      desc: L(who + " غيّر الوصف", who + " changed the description"),
      adminsOnly: ex.on ? L(who + " جعل الإرسال للمشرفين فقط", who + " allowed only admins to send") : L(who + " سمح للجميع بالإرسال", who + " allowed everyone to send"),
      vc_on: m.by === state.uid ? L("🎙 بدأتَ دردشةً صوتيّة", "🎙 You started a voice chat") : L("🎙 " + who + " بدأ دردشةً صوتيّة — انضمّ من الشريط أعلى المحادثة", "🎙 " + who + " started a voice chat — join from the bar at the top"),
      // C23
      local: m.text || "",
      e2e_on: m.by === state.uid ? L("🔒 بدأتَ محادثةً سرّيّة — مشفّرة بين الأجهزة، ولا يقرؤها خادم سوا", "🔒 You started a secret chat — end-to-end encrypted")
        : L("🔒 " + who + " بدأ محادثةً سرّيّة — مشفّرة بين الأجهزة، ولا يقرؤها خادم سوا", "🔒 " + who + " started a secret chat — end-to-end encrypted"),
      e2e_join: m.by === state.uid ? L("🔒 فعّلتَ المحادثة السرّيّة على هذا الجهاز", "🔒 You turned on the secret chat on this device") : L("🔒 " + who + " فعّل المحادثة السرّيّة على جهازه", "🔒 " + who + " turned on the secret chat"),
      e2e_rekey: m.by === state.uid ? L("🔐 نقلتَ المحادثة السرّيّة إلى جهازٍ جديد", "🔐 You moved the secret chat to a new device")
        : L("🔐 تغيّر رمز الأمان مع " + who + " (جهازٌ جديد) — قارنه من جديد إن أردت التأكّد", "🔐 Your safety code with " + who + " changed (new device)")
    };
    return T[ex.ev] || "";
  }
  // رسائل الأدوات بالشكل الذي تعرفه واجهة المجموعة
  function toolShape(m, o, c) {
    var ex = m.extra || {};
    if (m.type === "system") { o.type = "system"; o.text = sysText(m, c); return o; }
    if (m.type === "poll") {
      var votes = m.votes || {};
      o.type = "poll"; o.question = ex.question || ""; o.creatorId = appId(m.by); o.deadline = ex.deadline || null; o.anonymous = !!ex.anonymous; o.editedAt = ex.editedAt || null;
      var mine = ex.anonymous ? pollKey(m.id) : null;
      if (ex.anonymous && !mine && c && c.cid) wantPollKey(c.cid, m.id);
      // المجهول: لا هويّات — «أنا» إن كان المفتاح مفتاحي، والبقيّة معرّفاتٌ صمّاء للعدّ فقط
      var who = function (u) { return !ex.anonymous ? appId(u) : (u === mine || u === state.uid) ? appId(state.uid) : "anon:" + u.slice(-6); };
      o.options = (ex.options || []).map(function (text, i) { return { text: text, votes: Object.keys(votes).filter(function (u) { return votes[u] === i; }).map(who) }; });
      return o;
    }
    if (m.type === "bill") {
      var paid = m.paid || {};
      o.type = "billSplit"; o.description = ex.description || ""; o.totalAmount = ex.totalAmount || 0; o.splitType = ex.splitType || "equal";
      o.participants = (ex.participants || []).map(function (p) { return { userId: appId(p.uid), name: personName(p.uid, c), share: p.share || 0, paid: !!paid[p.uid], paidAt: paid[p.uid] || null }; });
      return o;
    }
    if (m.type === "fund") {
      var contrib = m.contrib || {}, ks = Object.keys(contrib);
      o.type = "fundraiser"; o.cause = ex.cause || ""; o.goal = ex.goal || 0; o.deadline = ex.deadline || null;
      o.raised = ks.reduce(function (s, u) { return s + (contrib[u].amount || 0); }, 0);
      o.contributions = ks.map(function (u) { return { name: personName(u, c), amount: contrib[u].amount || 0, ts: contrib[u].ts || 0 }; }).sort(function (a, b) { return b.ts - a.ts; });
      return o;
    }
    if (m.type === "tasks") {
      var ts = m.tstate || {};
      o.type = "taskList"; o.title = ex.title || "";
      o.tasks = (ex.tasks || []).map(function (t) { var s = ts[t.id] || {}; return { id: t.id, text: t.text, assigneeId: appId(t.assigneeId), assigneeName: t.assigneeName || personName(t.assigneeId, c), dueAt: t.dueAt || null, status: s.status || "pending", note: s.note || "" }; });
      return o;
    }
    return o;
  }
  function handleGroupParam() {
    var tok = null;
    try { tok = new URLSearchParams(global.location.search).get("group"); } catch (e) {}
    if (!tok) return;
    try { var u = new URL(global.location.href); u.searchParams.delete("group"); global.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash); } catch (e) {}
    whenReady(function () { afterOnb(function () { linkConfirm("group", tok); }); });
  }

  // ==================================================================
  // C4: الوسائط — صور (تُصغَّر) · فيديو · صوت · ملفّات (≤ ١٦ MB) · مشاهدة مرّة واحدة
  //     الرفع: الجهاز يكتب chats/{cid}/media/{mid} (+ قطع base64 ≤ ٧٠٠ ألف حرف في c/{i}) مباشرةً (القواعد تسمح للعضو المالك)،
  //     ثمّ يُرسل الرسالة عبر الـWorker (يتحقّق أنّ الوسيط له واكتمل). التنزيل عند الحاجة، ويُحفظ في IndexedDB.
  // ==================================================================
  var CHUNK = 700000, MAX_MEDIA = 16 * 1024 * 1024, AUTO_DL = 5 * 1024 * 1024;
  var mediaUrls = {}, mediaLoading = {}, localUrls = {}, mediaFailed = {};
  var MEDIA_TYPES = ["image", "video", "voice", "file"];
  function newMediaId() { return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ""); res(s.slice(s.indexOf(",") + 1)); };
      r.onerror = function () { rej(new Error("read")); };
      r.readAsDataURL(blob);
    });
  }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: mime || "application/octet-stream" });
  }
  function dataUrlToBlob(du) { var i = du.indexOf(","), mime = (du.slice(5, i).split(";")[0]) || "application/octet-stream"; return b64ToBlob(du.slice(i + 1), mime); }
  // ⛔ document.createElement("img") لا new Image() — sawa-app يحجب Image (انظر BUILD.md)
  function loadImg(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = document.createElement("img");
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }
  function drawTo(src, w, h, maxSide) {
    var sc = Math.min(1, maxSide / Math.max(w, h)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    var ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function canvasBlob(c, q) { return new Promise(function (res) { c.toBlob(function (b) { res(b); }, "image/jpeg", q); }); }
  function smallThumb(src, w, h) {   // ≤ ٦٠٠٠ حرف: معاينةٌ فوريّة داخل الرسالة نفسها
    var sizes = [96, 72, 56], qs = [0.5, 0.4, 0.3];
    for (var i = 0; i < sizes.length; i++) { var d = drawTo(src, w, h, sizes[i]).toDataURL("image/jpeg", qs[i]); if (d.length <= 6000) return d; }
    return null;
  }
  function prepareImage(blob) {
    if (/gif/.test(blob.type) && blob.size < 2 * 1024 * 1024) return loadImg(blob).then(function (r) { var th = smallThumb(r.img, r.img.naturalWidth, r.img.naturalHeight); URL.revokeObjectURL(r.url); return { blob: blob, thumb: th, w: r.img.naturalWidth, h: r.img.naturalHeight }; });
    return loadImg(blob).then(function (r) {
      var w = r.img.naturalWidth, h = r.img.naturalHeight, c = drawTo(r.img, w, h, 1280), th = smallThumb(r.img, w, h);
      URL.revokeObjectURL(r.url);
      return canvasBlob(c, 0.78).then(function (b) { return { blob: b && b.size < blob.size ? b : blob, thumb: th, w: c.width, h: c.height }; });
    });
  }
  function prepareVideo(blob) {
    return new Promise(function (res) {
      var url = URL.createObjectURL(blob), v = document.createElement("video"), done = false;
      var finish = function (th, dur, w, h) { if (done) return; done = true; URL.revokeObjectURL(url); res({ blob: blob, thumb: th, duration: dur, w: w, h: h }); };
      v.muted = true; v.playsInline = true; v.preload = "metadata";
      v.onloadeddata = function () { try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); } catch (e) { finish(null, v.duration, v.videoWidth, v.videoHeight); } };
      v.onseeked = function () { var th = null; try { th = smallThumb(v, v.videoWidth, v.videoHeight); } catch (e) {} finish(th, v.duration, v.videoWidth, v.videoHeight); };
      v.onerror = function () { finish(null, null, null, null); };
      setTimeout(function () { finish(null, null, null, null); }, 6000);
      v.src = url;
    });
  }
  // kind: image | video | voice | file · src: Blob/File أو dataURL
  // C32: مشاركة الموقع — يُطلب من الجهاز (دقّةٌ عالية، ١٥ ثانية) ويُرسل كرسالة «location» (وتُشفَّر في السرّيّة كغيرها)
  function sendLocation(cid, label) {
    if (!isCloud(cid) || !state.uid) return Promise.resolve(null);
    if (!(global.navigator && navigator.geolocation)) { toast(L("هذا الجهاز لا يدعم تحديد الموقع", "Location isn't supported on this device")); return Promise.resolve(null); }
    toast(L("📍 جارٍ تحديد موقعك…", "📍 Getting your location…"));
    return new Promise(function (res) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        var c = pos.coords;
        res(send(cid, null, { type: "location", extra: { lat: Math.round(c.latitude * 1e6) / 1e6, lng: Math.round(c.longitude * 1e6) / 1e6, acc: Math.round(c.accuracy || 0) || null, label: label ? String(label).slice(0, 120) : null } }));
      }, function (e) {
        toast(e && e.code === 1 ? L("لم يُسمح بالوصول إلى الموقع — فعّله من إعدادات المتصفّح", "Location permission denied — enable it in browser settings")
          : e && e.code === 3 ? L("تعذّر تحديد الموقع في الوقت المحدّد — جرّب في مكانٍ مكشوف", "Location timed out — try outdoors") : L("تعذّر تحديد الموقع", "Couldn't get your location"));
        res(null);
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }
  function mapsUrl(lat, lng) { return "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lng; }
  function sendMedia(cid, opts) {
    if (!isCloud(cid) || !state.uid) return null;
    var secret = e2eOn(chats[cid]);
    if (secret && e2eState(chats[cid]) !== "ready") { toast(e2eUi(chats[cid]).title || ""); return null; }   // C23
    var src = opts.blob || (opts.dataUrl ? dataUrlToBlob(opts.dataUrl) : null);
    if (!src) { toast(L("تعذّر قراءة الملفّ", "Couldn't read the file")); return null; }
    if (src.size > MAX_MEDIA - (secret ? 64 : 0)) { toast(L("الحدّ الأقصى ١٦ ميجابايت", "The limit is 16 MB")); return null; }
    var kind = opts.kind, id = newMsgId(), mid = newMediaId();
    var extra = { mid: mid, name: opts.name || src.name || null, mime: src.type || null, size: src.size };
    if (opts.viewOnce) extra.viewOnce = true;
    if (opts.duration) extra.duration = opts.duration;
    if (opts.transcript) extra.transcript = String(opts.transcript).slice(0, 1500);
    localUrls[mid] = URL.createObjectURL(src);
    var msg = { id: id, type: kind, extra: extra };
    if (opts.fwd) msg.fwd = true;   // C48: وسيطٌ موجَّه
    var p = { msg: msg, ts: Date.now(), status: "pending", uploading: true };
    (pend[cid] = pend[cid] || []).push(p);
    publishMessages(cid); publishChats();
    var prep = kind === "image" ? prepareImage(src) : kind === "video" ? prepareVideo(src) : Promise.resolve({ blob: src });
    // C23: في السرّيّة يُرفع الملفّ مشفّراً (مفتاحه داخل الرسالة المشفّرة) وبلا اسم
    var encP = null;
    var doUpload = function (blob, prog) {
      if (!secret) return uploadMedia(cid, mid, blob, extra, prog);
      if (!encP) encP = e2e.encFile(blob).then(function (ef) { extra.fk = ef.fk; extra.fiv = ef.fiv; return ef.blob; });
      return encP.then(function (eb) { return uploadMedia(cid, mid, eb, { name: "" }, prog); });
    };
    prep.then(function (r) {
      var blob = r.blob || src;
      if (r.thumb) extra.thumb = r.thumb;
      if (r.w) { extra.w = r.w; extra.h = r.h; }
      if (r.duration && !extra.duration) extra.duration = Math.round(r.duration);
      extra.size = blob.size; extra.mime = blob.type || extra.mime;
      if (blob !== src) { try { URL.revokeObjectURL(localUrls[mid]); } catch (e) {} localUrls[mid] = URL.createObjectURL(blob); }
      if (secret && extra.viewOnce) delete extra.thumb;
      publishMessages(cid);
      return doUpload(blob, function (pct) { p.progress = pct; publishMessages(cid); });
    }).then(function () {
      p.uploading = false;
      var ob = lsGet(OUTBOX, []); ob.push({ uid: state.uid, cid: cid, msg: msg }); lsSet(OUTBOX, ob);
      drainOutbox();
    }).catch(function (e) {
      p.uploading = false; p.reupload = function () { p.reupload = null; p.status = "pending"; p.uploading = true; publishMessages(cid); return prep.then(function (r) { return doUpload(r.blob || src, function (pct) { p.progress = pct; publishMessages(cid); }); })
        .then(function () { p.uploading = false; var ob = lsGet(OUTBOX, []); ob.push({ uid: state.uid, cid: cid, msg: msg }); lsSet(OUTBOX, ob); drainOutbox(); })
        .catch(function (e2) { setPend(cid, id, "failed"); toast(L("تعذّر رفع الملفّ: ", "Upload failed: ") + ((e2 && e2.message) || e2)); }); };
      setPend(cid, id, "failed");
      toast(L("تعذّر رفع الملفّ: ", "Upload failed: ") + ((e && e.message) || e) + L(" — اضغط ⚠ لإعادة المحاولة", " — tap ⚠ to retry"));
    });
    return id;
  }
  function uploadMedia(cid, mid, blob, extra, onProgress) {
    var d = fsdb(); if (!d) return Promise.reject(new Error("offline"));
    var meta = d.collection("chats").doc(cid).collection("media").doc(mid);
    // C16: حجز الرفع من الخادم أوّلاً (القواعد تطلبه) — حدٌّ يوميّ، وما لم يُرسل يُحذف بعد ٢٤ ساعة
    return call("media.begin", { cid: cid, mid: mid, size: blob.size }).catch(function (e) {
      var m = (e && e.message) || String(e);
      if (/quota/.test(m)) throw new Error(L("تجاوزت حدّ الرفع اليوميّ (٣٠٠ ميغابايت) — جرّب غداً", "Daily upload limit reached (300 MB)"));
      if (/unknown op/.test(m)) return null;   // خادمٌ أقدم
      throw e;
    }).then(function () { return blobToB64(blob); }).then(function (b64) {
      var n = Math.max(1, Math.ceil(b64.length / CHUNK));
      return meta.set({ by: state.uid, mime: blob.type || "application/octet-stream", size: blob.size, name: String(extra.name || "").slice(0, 200), n: n, ts: Date.now(), done: false })
        .then(function () {
          // ثلاث قطعٍ في وقتٍ واحد (أسرع على الجوّال من التسلسل)، مع نسبة التقدّم
          var i = 0, doneN = 0;
          if (onProgress) onProgress(0);
          var worker = function () {
            if (i >= n) return Promise.resolve();
            var k = i++;
            return meta.collection("c").doc(String(k)).set({ d: b64.slice(k * CHUNK, (k + 1) * CHUNK) })
              .then(function () { doneN++; if (onProgress) onProgress(Math.round(doneN * 100 / n)); return worker(); });
          };
          return Promise.all([worker(), worker(), worker()]);
        }).then(function () { return meta.update({ done: true }); });
    });
  }
  // ---------- التنزيل والتخزين المحلّيّ (IndexedDB) ----------
  var idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (res) {
      try {
        var r = indexedDB.open("sawa-media", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("m"); };
        r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return idbP;
  }
  function idbGet(k) { return idb().then(function (db_) { if (!db_) return null; return new Promise(function (res) { try { var q = db_.transaction("m").objectStore("m").get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }); }
  function idbPut(k, v) { return idb().then(function (db_) { if (!db_) return; try { db_.transaction("m", "readwrite").objectStore("m").put(v, k); } catch (e) {} }); }
  function fetchMedia(cid, mid) {
    var d = fsdb(); if (!d) return Promise.reject(new Error("offline"));
    var meta = d.collection("chats").doc(cid).collection("media").doc(mid);
    return Promise.all([meta.get(), meta.collection("c").get()]).then(function (r) {
      if (!r[0].exists) throw new Error("gone");
      var m = r[0].data() || {}, parts = [];
      r[1].forEach(function (doc) { parts.push({ i: Number(doc.id), d: (doc.data() || {}).d || "" }); });
      parts.sort(function (a, b) { return a.i - b.i; });
      if (m.n && parts.length < m.n) throw new Error("incomplete");
      return b64ToBlob(parts.map(function (p) { return p.d; }).join(""), m.mime);
    });
  }
  function ensureMedia(cid, mid, noCache) {
    if (!mid || mediaUrls[mid] || localUrls[mid] || mediaLoading[mid] || mediaFailed[mid]) return Promise.resolve(mediaUrls[mid] || localUrls[mid] || null);
    var mk2 = mediaKeys[cid + "|" + mid], sec = e2eOn(chats[cid]) || /^sdm_/.test(String(cid));
    if (sec && !mk2) return Promise.resolve(null);   // C23: مفتاح الوسيط داخل رسالته المشفّرة — بعد فكّها
    mediaLoading[mid] = true;
    return idbGet(mid).then(function (b) {
      var tmp = !!((chats[cid] || {}).disappear);   // C14: لا نحفظ وسائط المحادثات المؤقّتة على الجهاز
      return b || fetchMedia(cid, mid).then(function (blob) { return sec ? e2e.decFile(blob, mk2.fk, mk2.fiv, mk2.mime) : blob; })
        .then(function (blob) { if (!noCache && !tmp) idbPut(mid, blob); return blob; });
    }).then(function (blob) {
      mediaUrls[mid] = URL.createObjectURL(blob); delete mediaLoading[mid]; publishMessages(cid); return mediaUrls[mid];
    }).catch(function (e) {
      delete mediaLoading[mid]; mediaFailed[mid] = (e && e.message) || "x"; publishMessages(cid);
      // C18: تعثّر التنزيل (شبكة ضعيفة) ⇒ إعادة تلقائيّة بعد ٥ ثم ٢٠ ثم ٦٠ ثانية — كان يبقى «لم يصل» حتّى إعادة فتح التطبيق
      var n = (mediaTries[mid] = (mediaTries[mid] || 0) + 1);
      if (!/gone/.test(mediaFailed[mid]) && n <= 3) setTimeout(function () { if (mediaFailed[mid] && !mediaUrls[mid]) { delete mediaFailed[mid]; ensureMedia(cid, mid, noCache); } }, [5000, 20000, 60000][n - 1]);
      return null;
    });
  }
  var mediaTries = {};
  // C48: توجيه رسالةٍ بمحتواها: النصّ نصّاً، والوسائط بملفّها (يُنزَّل إن لزم ثمّ يُرفع للمحادثة الهدف)
  function forwardMessage(fromCid, id, toCid) {
    var f = findMsg(fromCid, id); if (!f || !toCid) return Promise.resolve(null);
    var m = f.msg; if (m.enc) m = plainOf(fromCid, m);
    var ex = m.extra || {};
    if (["image", "video", "file", "voice"].indexOf(m.type) < 0 || !ex.mid) { send(toCid, m.text || "", { fwd: true }); return Promise.resolve(true); }
    toast(L("جارٍ التوجيه…", "Forwarding…"));
    return ensureMedia(fromCid, ex.mid).then(function (url) {
      if (!url) throw new Error("no media");
      return fetch(url).then(function (r) { return r.blob(); });
    }).then(function (blob) {
      var b = (ex.mime && blob.type !== ex.mime) ? new Blob([blob], { type: ex.mime }) : blob;
      sendMedia(toCid, { kind: m.type, blob: b, name: ex.name || null, duration: ex.duration || null, transcript: ex.transcript || null, fwd: true });
      return true;
    }).catch(function () { toast(L("تعذّر توجيه الوسيط", "Couldn't forward the media")); return null; });
  }
  function retryMedia(cid, mid) { if (!mid) return; delete mediaFailed[mid]; mediaTries[mid] = 0; publishMessages(cid); return ensureMedia(cid, mid); }
  // ملفٌّ عامّ: يُنزَّل ثمّ يُفتح/يُحفظ
  function openFile(m) {
    if (!m || !m.cloudMid) return;
    var url = mediaUrls[m.cloudMid] || localUrls[m.cloudMid];
    var go = function (u) {
      if (!u) { toast(L("تعذّر تنزيل الملفّ", "Couldn't download the file")); return; }
      var a = document.createElement("a"); a.href = u; a.download = m.text || "file"; a.target = "_blank";
      document.body.appendChild(a); a.click(); setTimeout(function () { try { a.remove(); } catch (e) {} }, 500);
    };
    if (url) return go(url);
    delete mediaFailed[m.cloudMid];
    toast(L("جارٍ التنزيل…", "Downloading…"));
    ensureMedia(m.cloudCid, m.cloudMid).then(go);
  }
  function markViewedOnce(cid, id) {
    var f = findMsg(cid, id); if (!f) return;
    patchLocal(cid, id, function (m) { m.viewed = Object.assign({}, m.viewed); m.viewed[state.uid] = Date.now(); return m; });
    call("media.viewed", { cid: cid, day: f.day, id: id }).catch(fail);
  }
  // يحوّل رسالة وسائط إلى شكل الواجهة (ويطلب التنزيل التلقائيّ للصغير في المحادثة المفتوحة)
  function mediaShape(m, o, cid, mine) {
    var ex = m.extra || {}, mid = ex.mid, url = localUrls[mid] || mediaUrls[mid] || null;
    var viewedByMe = !!(m.viewed && m.viewed[state.uid]);
    o.cloudMid = mid; o.cloudCid = cid; o.fileSize = ex.size || 0; o.mime = ex.mime || null;
    if (m.type === "image" || m.type === "video") {
      o.viewOnce = !!ex.viewOnce; o.viewedOnce = !!ex.viewOnce && (mine || viewedByMe || !!m.gone);
      // الفيديو لا يُعرض بصورةٍ مصغّرة داخل <video> — يبقى «غير متاح» حتّى يكتمل تنزيله
      o.fileUrl = o.viewedOnce ? null : (url || (m.type === "image" ? ex.thumb || null : null)); o.thumb = ex.thumb || null; o.mediaLoading = !url && !mediaFailed[mid];
      o.text = ex.name || ""; o.w = ex.w || null; o.h = ex.h || null; o.durationSec = ex.duration || null;
    } else if (m.type === "voice") {
      o.audioUrl = url; o.duration = typeof ex.duration === "number" ? (Math.floor(ex.duration / 60) + ":" + String(ex.duration % 60).padStart(2, "0")) : (ex.duration || "0:00");
      o.transcript = ex.transcript || null;
      o.mediaLoading = !url && !mediaFailed[mid]; o.mediaFailed = !url && !!mediaFailed[mid];   // C18: الفقاعة تعرض «يُنزَّل…» أو «اضغط لإعادة التنزيل»
    } else { o.text = ex.name || L("ملفّ", "File"); o.fileUrl = url; }
    var auto = cid === openCid && !url && !mediaFailed[mid] && !(ex.viewOnce && (mine || viewedByMe || m.gone))
      && (m.type !== "file") && (m.type !== "video" || (ex.size || 0) <= AUTO_DL);
    if (auto) setTimeout(function () { ensureMedia(cid, mid, !!ex.viewOnce); }, 0);
    return o;
  }

  // ==================================================================
  // C5: الإشعارات — Firebase Cloud Messaging. الرمز يُسجَّل عند الـWorker (push.register)، وعامل الخدمة (sw.js)
  //     يُظهر الإشعار أو يمرّره للتطبيق المفتوح. الضغط على الإشعار يفتح المحادثة نفسها.
  // ==================================================================
  var VAPID_KEY = "BIXTjlI7zsibBBqZXkdIGu7tEnqVKf9Rf63v20ZdfNiNs6jj5olbf-a1SJ1SpnNm3OcC807QpPEUR7GrwMAuGdw";   // ← مفتاح Web Push العامّ (Firebase Console ← Cloud Messaging ← Web Push certificates)
  function pushSupported() {
    if (NB()) return true;
    try { return !!(VAPID_KEY && global.navigator && navigator.serviceWorker && global.PushManager && global.Notification && firebase.messaging && firebase.messaging.isSupported && firebase.messaging.isSupported()); }
    catch (e) { return false; }
  }
  function pushToken() {
    if (NB()) return new Promise(function (res, rej) {
      var t = ""; try { t = NB().fcmToken(); } catch (e) {}
      if (t) return res(t);
      var to = setTimeout(function () { rej(new Error("no native token")); }, 20000);
      natTokWait.push(function (x) { clearTimeout(to); if (x) res(x); else rej(new Error("no native token")); });
    });
    return navigator.serviceWorker.ready.then(function (reg) { return firebase.messaging().getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg }); });
  }
  function registerToken(tok) {
    var prev = lsGet("sawa_push", {});
    // C84: نجدّد التسجيل كلّ ٣ أيّام ولو لم يتغيّر الرمز — الخادم يحذف الأجهزة القديمة (٦٠ يوماً/أكثر من ٥)، وكان الهاتف يظنّ نفسه مسجّلاً للأبد
    if (prev.token === tok && prev.uid === state.uid && Date.now() - (prev.ts || 0) < 3 * 86400000) return Promise.resolve(true);
    return call("push.register", { token: tok, ua: (navigator.userAgent || "").slice(0, 150), prevUid: prev.uid && prev.uid !== state.uid ? prev.uid : null })
      .then(function () { lsSet("sawa_push", { token: tok, uid: state.uid, ts: Date.now() }); return true; });
  }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent || ""); }
  function pushState() {   // "granted" | "default" | "denied" | "off" (سُمح ثمّ أوقفه المستخدم من سوا) | "unsupported"
    if (NB()) { var np = "default"; try { np = NB().notifPermission() || "default"; } catch (e) {} if (np === "granted" && lsGet("sawa_push_off", 0)) return "off"; return np; }
    if (!pushSupported()) return "unsupported";
    var p; try { p = Notification.permission; } catch (e) { return "unsupported"; }
    if (p === "granted" && lsGet("sawa_push_off", 0)) return "off";
    return p;
  }
  function emitPush() { try { global.dispatchEvent(new CustomEvent("sawa-push-state", { detail: pushState() })); } catch (e) {} }
  function deniedHelp() {
    return isIOS()
      ? L("الإشعارات محظورة لسوا. افتح «الإعدادات» ← «الإشعارات» ← «سوا» وفعّل «السماح بالإشعارات».",
          "Notifications are blocked for Sawa. Open Settings → Notifications → Sawa and turn on Allow Notifications.")
      : L("الإشعارات محظورة لسوا. افعل الاثنين ثمّ أعد فتح سوا:\n١) اضغط مطوّلاً على أيقونة سوا ← «معلومات التطبيق» ← «الإشعارات» ← سماح.\n٢) افتح Chrome ← ⋮ ← الإعدادات ← إعدادات المواقع ← الإشعارات ← ابحث عن sawaaap.com ← سماح (أو احذفه من قائمة «محظور»).",
          "Notifications are blocked for Sawa. Do both, then reopen Sawa:\n1) Long-press the Sawa icon → App info → Notifications → Allow.\n2) Open Chrome → ⋮ → Settings → Site settings → Notifications → find sawaaap.com → Allow (or remove it from the Blocked list).");
  }
  function enablePush() {
    if (NB()) {   // C72: إذن أندرويد ثمّ رمز FCM الأصليّ
      try { localStorage.removeItem("sawa_push_off"); } catch (e) {}
      return new Promise(function (res) {
        var done = false, fin = function (st) {
          if (done) return; done = true;
          if (st !== "granted") { emitPush(); toast(L("لم تُفعَّل الإشعارات — فعّلها من إعدادات التطبيق", "Notifications weren't turned on")); return res(false); }
          lsSet("sawa_push", {});
          pushToken().then(registerToken).then(function () { toast(L("الإشعارات مفعّلة ✓", "Notifications on ✓")); hideBanner(); emitPush(); res(true); },
            function (e) { toast(L("تعذّر تفعيل الإشعارات: ", "Couldn't enable notifications: ") + ((e && e.message) || e)); res(false); });
        };
        natPermWait.push(fin);
        try { NB().requestNotifPermission(); } catch (e) { fin("denied"); }
        // صفحة الإعدادات لا ترجع بنتيجة ⇒ نفحص عند العودة إلى التطبيق
        var chk = setInterval(function () { if (done) { clearInterval(chk); return; } if (pushState() === "granted") { clearInterval(chk); fin("granted"); } }, 1500);
        setTimeout(function () { clearInterval(chk); if (!done) fin(pushState()); }, 60000);
      });
    }
    if (!VAPID_KEY) { toast(L("الإشعارات لم تُفعَّل بعد في هذا الإصدار", "Notifications aren't set up in this version yet")); return Promise.resolve(false); }
    if (!pushSupported()) { toast(L("هذا المتصفّح لا يدعم الإشعارات" + (isIOS() ? " — على آيفون ثبّت التطبيق على الشاشة الرئيسيّة أوّلاً" : ""), "This browser doesn't support notifications")); return Promise.resolve(false); }
    var perm0; try { perm0 = Notification.permission; } catch (e) {}
    if (perm0 === "denied") { hideBanner(); helpSheet(); return Promise.resolve(false); }
    try { localStorage.removeItem("sawa_push_off"); } catch (e) {}
    return Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") { emitPush(); if (perm === "denied") helpSheet(); else toast(L("لم تُفعَّل الإشعارات — يمكنك المحاولة لاحقاً", "Notifications weren't turned on")); return false; }
      return pushToken().then(function (tok) { lsSet("sawa_push", {}); return registerToken(tok); })
        .then(function () { toast(L("الإشعارات مفعّلة ✓", "Notifications on ✓")); hideBanner(); emitPush(); return true; });
    }).catch(function (e) {
      // C42: الإذن محظور (في التطبيق المثبَّت/TWA يأتي من Firebase برمز permission-blocked) ⇒ ورقة إرشادٍ عربيّة بدل نصّ الخطأ الخامّ
      var code = (e && e.code) || "", msg = String((e && e.message) || e || "");
      if (/permission-blocked|permission-default|denied/i.test(code + " " + msg) || (global.Notification && Notification.permission === "denied")) { lsSet("sawa_push_asked", Date.now()); helpSheet(); }
      else toast(L("تعذّر تفعيل الإشعارات: ", "Couldn't enable notifications: ") + msg);
      emitPush(); return false; });
  }
  function disablePush() {
    var prev = lsGet("sawa_push", {});
    lsSet("sawa_push", {}); lsSet("sawa_push_off", Date.now());
    var p = prev.token ? call("push.unregister", { token: prev.token }).catch(function () {}) : Promise.resolve();
    try { firebase.messaging().deleteToken().catch(function () {}); } catch (e) {}
    emitPush();
    return p;
  }
  function pushEnabled() { return pushState() === "granted"; }
  // بعد الدخول: إن سبق السماح نجدّد الرمز بصمت (يتغيّر أحياناً، أو تغيّر الحساب)؛ وإلا نعرض بطاقة التفعيل
  // C60: الرمز يموت أحياناً عند FCM بصمت (تغيّر اشتراك المتصفّح، مسح بيانات، خمول طويل) بينما يراه التطبيق صالحاً ⇒ الإشعارات والمكالمات لا تصل حتى «إعادة التسجيل».
  //   العلاج: تجديدٌ قسريّ (حذف الرمز ثمّ طلب رمزٍ جديد وتسجيله) كلّ ٧ أيّام، وفوراً حين يبلّغ عامل الخدمة بتغيّر الاشتراك (pushsubscriptionchange).
  var PUSH_ROTATE_MS = 7 * 86400000, rotating = null;
  function rotateToken(why) {
    if (rotating) return rotating;
    rotating = Promise.resolve().then(function () { return firebase.messaging().deleteToken().catch(function () {}); })
      .then(function () { lsSet("sawa_push", {}); return pushToken(); })
      .then(function (tok) { return registerToken(tok); })
      .then(function () { clearResubFlag(); log("push rotated:", why); return true; })
      .catch(function (e) { log("push rotate:", (e && e.message) || e); return false; })
      .then(function (ok) { rotating = null; return ok; });
    return rotating;
  }
  function clearResubFlag() {
    try { localStorage.removeItem("sawa_push_resub"); } catch (e) {}
    try { if (global.caches) caches.open("flags-sawa").then(function (c) { return c.delete("/push-resub"); }).catch(function () {}); } catch (e) {}
  }
  function resubFlagged() {
    if (lsGet("sawa_push_resub", 0)) return Promise.resolve(true);
    try { if (!global.caches) return Promise.resolve(false); return caches.open("flags-sawa").then(function (c) { return c.match("/push-resub"); }).then(function (r) { return !!r; }).catch(function () { return false; }); } catch (e) { return Promise.resolve(false); }
  }
  function refreshPush() {
    var st = pushState();
    emitPush();
    if (st === "default" || st === "denied") return maybeBanner(st);
    if (st !== "granted") return;
    var prev = lsGet("sawa_push", {});
    if (NB()) { pushToken().then(registerToken).catch(function (e) { log("native token:", (e && e.message) || e); }); return; }   // C72: أندرويد يجدّد رمزه وحده (onNewToken)
    resubFlagged().then(function (flag) {
      if (flag) return rotateToken("subscription changed");
      if (prev.token && prev.ts && Date.now() - prev.ts > PUSH_ROTATE_MS && navigator.onLine !== false) return rotateToken("weekly");
      return pushToken().then(registerToken);
    }).catch(function (e) { log("push token:", (e && e.message) || e); });
  }
  // بطاقة «فعّل الإشعارات» (تحتاج ضغطة المستخدم — المتصفّحات تمنع الطلب التلقائيّ)
  //  · لم يُسأل بعد ⇒ تظهر كلّ فتحٍ، و«لاحقاً» يؤجّلها يوماً · محظورة ⇒ تظهر أسبوعيّاً مع طريقة الفتح
  var bannerEl = null;
  function hideBanner() { try { if (bannerEl) bannerEl.remove(); } catch (e) {} bannerEl = null; }
  function bannerShell() {
    var el = document.createElement("div");
    el.dir = isAr() ? "rtl" : "ltr"; el.id = "sawa-push-card";
    el.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:2147483640;background:#1f2d3a;color:#fff;border-radius:16px;padding:12px 14px;font:600 13px/1.6 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;max-width:520px;margin:0 auto";
    return el;
  }
  function btn(text, primary) {
    var b = document.createElement("button"); b.textContent = text;
    b.style.cssText = primary ? "background:#2e7d5b;color:#fff;border:0;border-radius:10px;padding:8px 12px;font:700 13px system-ui;white-space:nowrap"
                              : "background:transparent;color:#cfd8dc;border:0;padding:8px 6px;font:600 12px system-ui;white-space:nowrap";
    return b;
  }
  function maybeBanner(st) {
    st = st || pushState();
    if (bannerEl || !document.body || onbActive()) return;
    if (st !== "default" && st !== "denied") return;
    var snooze = st === "denied" ? 7 * 86400000 : 86400000;
    if (lsGet("sawa_push_asked", 0) > Date.now() - snooze) return;
    if (global.SawaRTC && ((SawaRTC.active && SawaRTC.active()) || (SawaRTC.group && SawaRTC.group()) || (SawaRTC.room && SawaRTC.room()))) return;
    bannerEl = bannerShell();
    var txt = document.createElement("div"); txt.style.flex = "1";
    txt.textContent = st === "denied"
      ? L("🔕 الإشعارات محظورة — لن تصلك الرسائل والمكالمات والتطبيق مغلق", "🔕 Notifications are blocked — you won't get messages or calls while the app is closed")
      : L("🔔 فعّل الإشعارات لتصلك الرسائل والمكالمات والتطبيق مغلق", "🔔 Turn on notifications to get messages and calls when the app is closed");
    var yes = btn(st === "denied" ? L("كيف أفتحها؟", "How?") : L("تفعيل", "Turn on"), true);
    var no = btn(L("لاحقاً", "Later"));
    yes.onclick = function () { hideBanner(); if (st === "denied") { lsSet("sawa_push_asked", Date.now()); helpSheet(); } else enablePush(); };
    no.onclick = function () { lsSet("sawa_push_asked", Date.now()); hideBanner(); };
    bannerEl.appendChild(txt); bannerEl.appendChild(yes); bannerEl.appendChild(no); document.body.appendChild(bannerEl);
  }
  // C56: ورقة «فحص الإشعارات»: الإذن · الدعم · تسجيل الجهاز · أجهزتي على الخادم · إشعار تجريبيّ حقيقيّ · إعادة التسجيل · إرشادات أندرويد
  function pushCheckSheet() {
    var s = sheet(L("🔔 فحص الإشعارات والمكالمات في الخلفية", "🔔 Notifications & background calls check"));
    var row = function (k, v, good) { var r = mk("div", "display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #eef2f6;font:600 13px system-ui"); r.appendChild(mk("span", "color:#5b6b7c", k)); r.appendChild(mk("span", "color:" + (good === true ? "#2e7d5b" : good === false ? "#b42318" : "#1A1A2E") + ";text-align:" + (isAr() ? "left" : "right"), v)); return r; };
    var st = pushState(), sup = pushSupported(), reg = lsGet("sawa_push", {}), sa = isStandalone();
    var box = s.box;
    var nbp = ""; try { nbp = NB() ? NB().platform() : ""; } catch (e) {}
    box.appendChild(row(L("طريقة الفتح", "Opened as"), nbp ? L("تطبيق أندرويد الأصليّ ", "Native Android app ") + nbp.replace("android/", "v") : sa ? L("تطبيقٌ مثبّت", "Installed app") : L("متصفّح", "Browser")));
    box.appendChild(row(L("دعم المتصفّح", "Browser support"), sup ? L("مدعوم ✓", "Supported ✓") : L("غير مدعوم", "Not supported"), sup));
    box.appendChild(row(L("إذن الإشعارات", "Permission"), st === "granted" ? L("مسموح ✓", "Granted ✓") : st === "denied" ? L("محظور ✗", "Blocked ✗") : st === "off" ? L("موقوف من سوا", "Off in Sawa") : st === "default" ? L("لم يُطلب بعد", "Not asked yet") : "—", st === "granted" ? true : st === "default" ? null : false));
    box.appendChild(row(L("هذا الجهاز مسجّل", "This device registered"), reg.token && reg.uid === state.uid ? L("نعم ✓ — ", "Yes ✓ — ") + timeAgo(reg.ts || 0) : L("لا ✗", "No ✗"), !!(reg.token && reg.uid === state.uid)));
    var srv = row(L("أجهزتك عند الخادم", "Devices on server"), "…"); box.appendChild(srv);
    // C82: في تطبيق أندرويد — إعدادات الهاتف التي تقرّر وصول المكالمات والتطبيق مغلق، مع زرّ إصلاحٍ لكلٍّ منها
    if (NB() && NB().bgStatus) {
      var phone = mk("div", "margin:14px 0 4px;padding:12px;border-radius:14px;background:#f6f8fb"); box.appendChild(phone);
      var drawPhone = function () {
        var bs = {}; try { bs = JSON.parse(NB().bgStatus()) || {}; } catch (e) {}
        phone.innerHTML = "";
        phone.appendChild(mk("div", "font:800 13.5px system-ui;margin-bottom:6px", L("📱 إعدادات الهاتف (للمكالمات والتطبيق مغلق)", "📱 Phone settings (for calls when closed)")));
        var item = function (label, okv, kind, hint) {
          var r = mk("div", "display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #e8edf3");
          var tx = mk("div", "flex:1;font:600 12.5px system-ui;color:#1f2d3d", (okv === null ? "🔧 " : okv ? "✅ " : "⚠️ ") + label);
          if (hint && !okv) tx.appendChild(mk("div", "font:500 11px system-ui;color:#8796a5;margin-top:2px", hint));
          r.appendChild(tx);
          if (kind) { var b = mkBtn(okv === false ? L("إصلاح", "Fix") : L("فتح", "Open"), okv === false ? "primary" : ""); b.style.cssText += ";width:auto;padding:6px 12px;margin:0;font-size:12px"; b.onclick = function () { try { NB().openSetting(kind); } catch (e) {} }; r.appendChild(b); }
          phone.appendChild(r);
        };
        item(L("إشعارات سوا مسموحة", "Sawa notifications allowed"), !!bs.notif, "notif");
        if (bs.callsChannel != null && bs.callsChannel >= 0) item(L("قناة «المكالمات» بصوتٍ وظهورٍ على الشاشة", "Calls channel: sound & pop-up"), bs.callsChannel >= 4, "calls", L("اجعلها «عاجلة» مع الصوت والظهور فوق الشاشة", "Set it to Urgent with sound and pop-up"));
        item(L("شاشة المكالمة الكاملة فوق القفل", "Full-screen call screen"), bs.fullScreen !== false, bs.sdk >= 34 ? "fullscreen" : null, L("اسمح لسوا بـ«إشعارات ملء الشاشة»", "Allow Sawa full-screen notifications"));
        item(L("البطاريّة: بلا قيود", "Battery: unrestricted"), !!bs.battery, "battery", L("وإلّا يوقف الهاتف سوا في الخلفيّة فلا تصل المكالمات", "Otherwise the phone stops Sawa in the background"));
        var hw = /honor|huawei|xiaomi|redmi|oppo|vivo|realme|tecno|infinix|itel/.test(bs.maker || "");
        item(hw ? L("التشغيل التلقائيّ / إدارة تشغيل التطبيقات ← سوا: يدويّ وكلّ المفاتيح مفعّلة", "Auto-launch: Sawa manual, all toggles on") : L("التشغيل في الخلفيّة", "Background launch"), null, "launch",
          hw ? L("في هاتف " + (bs.maker || "") + " هذا الإعداد هو الأهمّ: بدونه لا تصل الإشعارات إلّا والتطبيق مفتوح", "On this phone this matters most") : "");
        if (!bs.fcm) phone.appendChild(note(L("لا رمز إشعارات من Google على هذا الهاتف بعد — اضغط «إعادة تسجيل هذا الجهاز».", "No Google push token yet — tap Re-register."), "#b42318", "#fdecec"));
        // C84: آخر إشعارٍ وصل الهاتف فعلاً (يسجّله التطبيق الأصليّ لحظة الاستلام) — يفصل «لم يصل أصلاً» عن «وصل ولم يظهر»
        var lp = bs.lastPush || null;
        phone.appendChild(note(lp && lp.ts
          ? L("📥 آخر إشعار وصل هذا الهاتف: ", "📥 Last push received: ") + timeAgo(lp.ts) + " (" + (lp.t || "?") + (lp.fg ? L(" · والتطبيق مفتوح", " · app open") : L(" · والتطبيق مغلق ✓", " · app closed ✓")) + ")" + (lp.shown === false ? L(" — لكنّ الهاتف منع عرضه ✗", " — but the phone blocked showing it ✗") : "")
          : L("📥 لم يصل هذا الهاتفَ أيّ إشعار منذ تثبيت هذه النسخة.", "📥 No push has reached this phone since this version was installed."), lp && lp.ts ? "#2e7d5b" : "#b45309", lp && lp.ts ? "#eaf6ef" : "#fff7e6"));
      };
      drawPhone();
      var onVis = function () { if (document.visibilityState === "visible" && document.body.contains(phone)) drawPhone(); else if (!document.body.contains(phone)) document.removeEventListener("visibilitychange", onVis); };
      document.addEventListener("visibilitychange", onVis);
    }
    var out = mk("div", "margin:10px 0 4px"); box.appendChild(out);
    var test = mkBtn(L("أرسل إشعاراً تجريبيّاً الآن", "Send a test notification now"), "primary"); test.style.marginTop = "10px";
    var fix = mkBtn(L("إعادة تسجيل هذا الجهاز", "Re-register this device")); fix.style.marginTop = "8px";
    var en = mkBtn(st === "denied" ? L("كيف أفتح الإشعارات؟", "How do I unblock?") : L("تفعيل الإشعارات", "Turn on notifications"), "primary"); en.style.marginTop = "8px";
    if (st === "granted") box.appendChild(test); else box.appendChild(en);
    // C71: الاختبار الحقيقيّ — التطبيق مغلق. يُرسل الخادم بعد ١٥ ثانية؛ أغلق سوا الآن وانتظر
    var bg = mkBtn(L("🕒 اختبار والتطبيق مغلق (بعد ١٥ ثانية)", "🕒 Test with the app closed (in 15s)")); bg.style.marginTop = "8px";
    bg.onclick = function () {
      bg.disabled = true; bg.textContent = "…";
      call("push.test", { delay: 15000 }).then(function () {
        bg.textContent = L("أُرسل ✓ — أغلق سوا الآن (زرّ الرئيسيّة) وانتظر ١٥ ثانية", "Queued ✓ — close Sawa now (Home) and wait 15s");
        toast(L("أغلق التطبيق الآن — سيصلك إشعار بعد ١٥ ثانية إن كانت الإشعارات تعمل في الخلفيّة", "Close the app now — a notification should arrive in 15s"));
      }, function (e) { bg.disabled = false; bg.textContent = L("🕒 اختبار والتطبيق مغلق (بعد ١٥ ثانية)", "🕒 Test with the app closed (in 15s)"); toast((e && e.message) || String(e)); });
    };
    if (st === "granted") box.appendChild(bg);
    if (st === "granted") box.appendChild(fix);
    var tips = note(sa
      ? L("إن قال الخادم «وصل» ولم يظهر شيء على هاتفك:\n١) اضغط مطوّلاً على أيقونة سوا ← «معلومات التطبيق» ← «الإشعارات» ← مسموح.\n٢) في «معلومات التطبيق» أيضاً: «البطاريّة» ← «بلا قيود» (هواتف Tecno/Infinix/Xiaomi/Huawei توقف الخلفية).\n٣) Chrome ← ⋮ ← الإعدادات ← إعدادات الموقع ← الإشعارات ← sawaaap.com مسموح.\nالمكالمات تصل كإشعارٍ يرنّ؛ اضغطه لترُدّ.",
          "If the server says delivered but nothing shows:\n1) Long-press the Sawa icon → App info → Notifications → Allowed.\n2) App info → Battery → Unrestricted (Tecno/Infinix/Xiaomi/Huawei kill background apps).\n3) Chrome → ⋮ → Settings → Site settings → Notifications → sawaaap.com allowed.\nCalls arrive as a ringing notification; tap it to answer.")
      : L("للمكالمات والرسائل والتطبيق مغلق: ثبّت سوا على الشاشة الرئيسيّة وفعّل الإشعارات، وفي «معلومات التطبيق» اجعل البطاريّة «بلا قيود».", "For calls and messages while closed: install Sawa to the home screen, allow notifications, and set Battery → Unrestricted in App info."), "#5b6b7c", "#f5f7fa");
    tips.style.whiteSpace = "pre-line"; tips.style.marginTop = "12px"; box.appendChild(tips);
    var closeB = mkBtn(L("إغلاق", "Close"), "ghost"); closeB.style.marginTop = "6px"; closeB.onclick = s.close; box.appendChild(closeB);
    var myTail = ""; try { myTail = NB() && NB().fcmToken ? String(NB().fcmToken() || "").slice(-8) : String((reg && reg.token) || "").slice(-8); } catch (e) {}
    var markMine = function (list) {   // C84: أيّ أجهزة الخادم هو هذا الهاتف؟ إن لم يكن بينها ⇒ هذا سبب عدم الوصول
      if (!myTail || !list) return;
      var mine = list.some(function (r) { return r.tail === myTail; });
      out.appendChild(note(mine ? L("📱 هذا الهاتف مسجّلٌ عند الخادم ✓ (…" + myTail.slice(-4) + ")", "📱 This phone is registered on the server ✓")
                              : L("📱 رمز هذا الهاتف ليس بين أجهزتك عند الخادم ✗ — لذلك لا تصله الإشعارات. اضغط «إعادة تسجيل هذا الجهاز».", "📱 This phone's token isn't on the server ✗ — tap Re-register."),
                          mine ? "#2e7d5b" : "#b42318", mine ? "#eaf6ef" : "#fdecec"));
    };
    function runTest(label) {
      test.disabled = true; test.textContent = L("جارٍ الإرسال…", "Sending…"); out.innerHTML = "";
      return call("push.test", {}).then(function (b) {
        srv.lastChild.textContent = String(b.devices || 0);
        if (!b.devices) { out.appendChild(note(L("لا جهاز مسجّلاً عند الخادم — اضغط «إعادة تسجيل هذا الجهاز».", "No device registered on the server — tap Re-register."), "#b42318", "#fdecec")); return; }
        markMine(b.results);
        (b.results || []).forEach(function (r) {
          out.appendChild(note((r.ok ? "✓ " : "✗ ") + (myTail && r.tail === myTail ? L("📱 هذا الهاتف · ", "📱 this phone · ") : "") + (r.ua || L("جهاز", "device")) + " · " + timeAgo(r.ts || 0) + (r.ok ? L(" — أرسله الخادم. إن لم يظهر خلال ١٠ ثوانٍ فالمشكلة في إعدادات الهاتف (انظر أدناه).", " — sent by the server. If nothing shows in 10 s, the phone's settings block it (see below).") : r.err === "gone" ? L(" — رمزٌ ميّت (حُذف) — أعد التسجيل.", " — dead token (removed) — re-register.") : " — " + r.err), r.ok ? "#2e7d5b" : "#b42318", r.ok ? "#eaf6ef" : "#fdecec"));
        });
      }).catch(function (e) { out.appendChild(note(L("تعذّر الاختبار: ", "Test failed: ") + ((e && e.message) || e), "#b42318", "#fdecec")); })
        .then(function () { test.disabled = false; test.textContent = L("أرسل إشعاراً تجريبيّاً الآن", "Send a test notification now"); });
    }
    test.onclick = function () { runTest(); };
    fix.onclick = function () {
      fix.disabled = true; fix.textContent = L("جارٍ…", "…");
      lsSet("sawa_push", {});
      var p = Promise.resolve(); try { p = firebase.messaging().deleteToken().catch(function () {}); } catch (e) {}
      p.then(pushToken).then(registerToken).then(function () { toast(L("أُعيد تسجيل الجهاز ✓", "Device re-registered ✓")); s.close(); pushCheckSheet(); })
        .catch(function (e) { fix.disabled = false; fix.textContent = L("إعادة تسجيل هذا الجهاز", "Re-register this device"); toast(L("تعذّر: ", "Failed: ") + ((e && e.message) || e)); });
    };
    en.onclick = function () { s.close(); if (st === "denied") helpSheet(); else enablePush().then(function (ok) { if (ok) pushCheckSheet(); }); };
    // عدد الأجهزة عند الخادم (بلا إرسال)
    if (st === "granted") call("push.test", { dry: true }).then(function (b) { srv.lastChild.textContent = String(b.devices || 0); srv.lastChild.style.color = b.devices ? "#2e7d5b" : "#b42318"; if (b.tails) markMine(b.tails); }).catch(function () { srv.lastChild.textContent = "؟"; });
    else srv.lastChild.textContent = "—";
    return s;
  }
  function helpSheet() {
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center";
    var box = document.createElement("div"); box.dir = isAr() ? "rtl" : "ltr";
    box.style.cssText = "background:#fff;color:#1f2937;border-radius:18px 18px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom,0px));width:100%;max-width:520px;font:500 14px/1.8 system-ui";
    var h = document.createElement("div"); h.style.cssText = "font:800 16px system-ui;margin-bottom:6px"; h.textContent = L("🔔 تفعيل الإشعارات", "🔔 Turn on notifications");
    var p = document.createElement("div"); p.textContent = deniedHelp(); p.style.whiteSpace = "pre-line";
    var ok = btn(L("حسناً", "OK"), true); ok.style.marginTop = "12px"; ok.style.width = "100%";
    ok.onclick = function () { try { ov.remove(); } catch (e) {} };
    ov.onclick = function (e) { if (e.target === ov) ok.onclick(); };
    box.appendChild(h); box.appendChild(p); box.appendChild(ok); ov.appendChild(box); document.body.appendChild(ov);
  }
  // عند العودة للتطبيق: ربّما غيّر المستخدم الإذن من إعدادات الهاتف
  try {
    var lastPushSt = null;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible" || !state.uid) return;
      var st = pushState(); if (st === lastPushSt) return; lastPushSt = st;
      if (st === "granted") { hideBanner(); refreshPush(); } else emitPush();
    });
  } catch (e) {}

  // ==================================================================
  // C9: تحديثات التطبيق — sw.js «المخزون أوّلاً»؛ نسخةٌ جديدة ⇒ تُحمَّل في الخلفيّة ثمّ:
  //   خلال ثوانٍ من الفتح ⇒ إعادة تحميلٍ تلقائيّة · غير ذلك ⇒ شريط «تحديث جديد» (لا نقطع مكالمةً أو كتابة)
  // ==================================================================
  // C83: «تحديث التطبيق» لكلّ مستخدم — نسخة الجهاز ونسخة الخادم و«ما الجديد» وتحديثٌ قسريّ آمن (لا يمسّ الحساب ولا البيانات)
  var upd = { local: null, server: null, notes: "", checkedAt: 0, available: false, bar: null, inCall: function () { return false; } };
  function swLocalVersion() {
    return new Promise(function (res) {
      try {
        var sw = navigator.serviceWorker; if (!sw || !sw.controller) return res(null);
        var done = false, on = function (ev) { var d = ev.data || {}; if (d.type === "sawa-version" && !done) { done = true; sw.removeEventListener("message", on); res(d.version || null); } };
        sw.addEventListener("message", on); sw.controller.postMessage({ type: "sawa-version" });
        setTimeout(function () { if (!done) { done = true; sw.removeEventListener("message", on); res(null); } }, 2500);
      } catch (e) { res(null); }
    });
  }
  function checkUpdate(silent) {
    return Promise.all([
      fetch("/sw.js?t=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; }).catch(function () { return ""; }),
      swLocalVersion()
    ]).then(function (x) {
      var m = x[0].match(/sawa-v\d+/), n = x[0].match(/const NOTES = '([^']*)'/);
      upd.server = m ? m[0] : upd.server; upd.notes = n ? n[1].replace(/\\n/g, "\n") : upd.notes;
      upd.local = x[1] || upd.local; upd.checkedAt = Date.now();
      var was = upd.available;
      upd.available = !!(upd.server && upd.local && upd.server !== upd.local);
      try { global.dispatchEvent(new CustomEvent("sawa-update-state", { detail: { available: upd.available } })); } catch (e) {}
      // إشعار التحديث لأيّ مستخدم: شريطٌ أعلى الشاشة (مرّةً لكلّ نسخة)
      if (upd.available && !was && !silent && upd.bar && lsGet("sawa_upd_dismissed", "") !== upd.server) upd.bar();
      return upd;
    });
  }
  function forceUpdate() {
    if (upd.inCall() && !global.confirm(L("ستنتهي المكالمة الحاليّة. تحديث الآن؟", "This will end the current call. Update now?"))) return;
    var jobs = [];
    try {
      if (global.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf("sawa-") === 0; }).map(function (k) { return caches.delete(k); })); }));
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
    } catch (e) {}
    Promise.all(jobs).catch(function () {}).then(function () { global.location.replace("/?fresh=" + Date.now()); });
  }
  function updateSheet() {
    var s = sheet(L("🔄 تحديث التطبيق", "🔄 App update"));
    var box = s.box;
    var row = function (k, v, good) { var r = mk("div", "display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #eef2f6;font:600 13px system-ui"); r.appendChild(mk("span", "color:#5b6b7c", k)); r.appendChild(mk("span", "color:" + (good === false ? "#b45309" : good ? "#2e7d5b" : "#1f2d3d") + ";text-align:end", v)); return r; };
    var body = mk("div"); box.appendChild(body);
    var draw = function () {
      body.innerHTML = "";
      var nbp = ""; try { nbp = NB() ? NB().platform() : ""; } catch (e) {}
      body.appendChild(row(L("نسخة سوا على جهازك", "Version on this device"), (upd.local || "…").replace("sawa-", ""), upd.local ? !upd.available : null));
      body.appendChild(row(L("أحدث نسخة", "Latest version"), (upd.server || "…").replace("sawa-", "")));
      if (nbp) body.appendChild(row(L("تطبيق أندرويد", "Android app"), nbp.replace("android/", "v")));
      body.appendChild(row(L("آخر فحص", "Last checked"), upd.checkedAt ? timeAgo(upd.checkedAt) : "…"));
      body.appendChild(note(upd.available ? L("✨ نسخةٌ جديدة متاحة — اضغط «تحديث الآن».", "✨ A new version is available — tap Update now.")
        : upd.local ? L("✓ لديك أحدث نسخة.", "✓ You're up to date.") : L("جارٍ الفحص…", "Checking…"), upd.available ? "#8a5a00" : "#2e7d5b", upd.available ? "#fff6e5" : "#eaf7f0"));
      if (upd.notes) { var nn = note(L("ما الجديد: ", "What's new: ") + upd.notes); nn.style.whiteSpace = "pre-line"; nn.style.marginTop = "8px"; body.appendChild(nn); }
    };
    draw();
    var go = mkBtn(L("تحديث الآن", "Update now"), "primary"); go.style.marginTop = "12px";
    go.onclick = function () { go.disabled = true; go.textContent = "…"; forceUpdate(); };
    var chk = mkBtn(L("التحقّق من وجود تحديث", "Check for updates")); chk.style.marginTop = "8px";
    chk.onclick = function () { chk.disabled = true; chk.textContent = "…"; checkUpdate(true).then(function () { draw(); chk.disabled = false; chk.textContent = L("التحقّق من وجود تحديث", "Check for updates"); }); };
    box.appendChild(go); box.appendChild(chk);
    box.appendChild(note(L("«تحديث الآن» يجلب أحدث ملفّات سوا من الخادم ويعيد فتح التطبيق — لا يمسّ حسابك ولا محادثاتك ولا شجرتك.", "Update now fetches the latest Sawa files and reopens the app — your account and data stay.")));
    var closeB = mkBtn(L("إغلاق", "Close"), "ghost"); closeB.style.marginTop = "6px"; closeB.onclick = s.close; box.appendChild(closeB);
    checkUpdate(true).then(draw);
    return s;
  }
  // فحصٌ بعد الفتح بقليل، وكلّ ١٠ دقائق والتطبيق ظاهر
  setTimeout(function () { checkUpdate(false); }, 6000);
  setInterval(function () { if (document.visibilityState === "visible") checkUpdate(false); }, 10 * 60000);
  (function swUpdates() {
    try { if (!global.navigator || !navigator.serviceWorker) return; } catch (e) { return; }
    var t0 = Date.now(), had = !!navigator.serviceWorker.controller, reloading = false, upEl = null, lastCheck = Date.now();
    function inCall() { var R = global.SawaRTC; try { return !!(R && ((R.active && R.active()) || (R.group && R.group()) || (R.room && R.room()))); } catch (e) { return false; } }
    function reload() { if (reloading) return; reloading = true; try { global.location.reload(); } catch (e) {} }
    function bar() {
      if (upEl || !document.body) return;
      upEl = bannerShell(); upEl.style.bottom = ""; upEl.style.top = "calc(10px + env(safe-area-inset-top,0px))"; upEl.style.background = "#2F80C8";
      var txt = document.createElement("div"); txt.style.flex = "1"; txt.textContent = L("✨ نسخةٌ جديدة من سوا جاهزة", "✨ A new version of Sawa is ready");
      var yes = btn(L("تحديث", "Update"), true); yes.style.background = "#fff"; yes.style.color = "#2F80C8";
      var no = btn(L("لاحقاً", "Later")); no.style.color = "#e3f0fb";
      // C83: إن لم يتبدّل عامل الخدمة بعد (التحديث لم يُنزَّل) فإعادة التحميل لا تكفي ⇒ تحديثٌ قسريّ
      yes.onclick = function () { if (upd.available && navigator.serviceWorker && !reloading) { forceUpdate(); return; } if (inCall() && !global.confirm(L("ستنتهي المكالمة الحاليّة. تحديث الآن؟", "This will end the current call. Update now?"))) return; reload(); };
      no.onclick = function () { if (upd.server) lsSet("sawa_upd_dismissed", upd.server); try { upEl.remove(); } catch (e) {} upEl = null; };
      upEl.appendChild(txt); upEl.appendChild(yes); upEl.appendChild(no); document.body.appendChild(upEl);
    }
    upd.bar = bar; upd.inCall = inCall;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!had) { had = true; return; }            // أوّل تثبيتٍ لعامل الخدمة: لا شيء تغيّر في الصفحة
      if (Date.now() - t0 < 10000 && !inCall()) return reload();
      bar();
    });
    // التطبيق المثبّت قد يبقى مفتوحاً أيّاماً في الخلفيّة دون «فتحٍ» جديد ⇒ نفحص sw.js عند العودة (مرّةً كلّ 30 دقيقة)
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < 30 * 60000) return;
      lastCheck = Date.now();
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) return r.update(); }).catch(function () {});
    });
  })();

  // عامل الخدمة → التطبيق: إشعارٌ والتطبيق أمامك (تنبيهٌ داخليّ) · ضغطٌ على إشعار (افتح المحادثة)
  function openFromPush(cid) { if (cid && isCloud(cid)) whenApp(function () { try { if (app.openChatById) app.openChatById(cid); } catch (e) {} }); }
  try {
    if (global.navigator && navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", function (ev) {
      var m = ev.data || {};
      if (m.type === "sawa-push" && m.data) {
        if (m.data.t !== "call" && m.data.cid !== openCid) toast((m.data.title ? m.data.title + ": " : "") + (m.data.body || ""));
        if (m.data.t === "req") loadRequests();
        if (m.data.t === "vouchok") { state.me = Object.assign({}, state.me || {}, { phoneVerified: true, verifiedBy: "contacts" }); publish(); try { if (app && app.setMyProfile) app.setMyProfile(profile()); } catch (e) {} toast(L("تأكّد رقمك ✓", "Your number is confirmed ✓")); }
        if (m.data.t === "reqok") { refresh(); loadRequests(); }
      }
      if (m.type === "sawa-open" && m.data) { if (m.data.t === "req") whenReady(function () { requestsSheet(); }); else openFromPush(m.data.cid); }
      // C60: عامل الخدمة يبلّغ أنّ اشتراك الإشعارات تغيّر ⇒ رمزٌ جديد فوراً
      if (m.type === "sawa-push-resub") { lsSet("sawa_push_resub", Date.now()); if (pushState() === "granted" && state.uid) rotateToken("sw resub"); }
    });
  } catch (e) {}
  function handleChatParam() {
    var cid = null;
    try { cid = new URLSearchParams(global.location.search).get("chat"); } catch (e) {}
    if (!cid) return;
    try { var u = new URL(global.location.href); u.searchParams.delete("chat"); global.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash); } catch (e) {}
    whenReady(function () { setTimeout(function () { openFromPush(cid); }, 600); });
  }
  // عدد غير المقروء على أيقونة التطبيق (حيث يدعمه الجهاز)
  var badgeN = -1;
  function appBadge() {
    var n = 0; Object.keys(chats).forEach(function (k) { n += unreadOf(chats[k]); });
    if (n === badgeN) return; badgeN = n;
    try { if (navigator.setAppBadge) { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
  }

  // ==================================================================
  // C10: رمز سوا (١٠ أرقام) + طلبات التواصل + الدخول بالبريد + شاشات البداية للمستخدم الجديد
  //   الرمز: ٩ أرقام عشوائيّة (أوّلها ١–٩) + رقم تحقّق (Luhn) يكشف خطأ رقمٍ واحد أو تبديل رقمين.
  //   من يُدخل الرمز يرى الاسم فقط ويرسل «طلب تواصل» — لا مراسلة ولا اتّصال قبل القبول.
  // ==================================================================
  function codeDigits(x) {
    return String(x == null ? "" : x).replace(/[٠-٩]/g, function (d) { return "٠١٢٣٤٥٦٧٨٩".indexOf(d); })
      .replace(/[۰-۹]/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); }).replace(/\D/g, "");
  }
  function luhnDigit(s) {
    var sum = 0;
    for (var i = 0; i < s.length; i++) { var d = Number(s[s.length - 1 - i]); if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    return String((10 - (sum % 10)) % 10);
  }
  function codeValid(c) { return /^[1-9]\d{9}$/.test(c) && luhnDigit(c.slice(0, 9)) === c[9]; }
  function fmtCode(c) { c = codeDigits(c); return c.length > 6 ? c.slice(0, 3) + " " + c.slice(3, 6) + " " + c.slice(6) : c.length > 3 ? c.slice(0, 3) + " " + c.slice(3) : c; }
  function myCode() { return (state.me && state.me.code) || null; }
  function codeUrl(c) { return global.location.origin + global.location.pathname.replace(/index\.html$/, "") + "?code=" + codeDigits(c); }
  function codeShareText(c) {
    return L("تواصل معي على سوا — رمزي: ", "Reach me on Sawa — my code: ") + fmtCode(c) + "\n" + codeUrl(c);
  }
  function loadCode() {
    if (myCode()) return Promise.resolve({ code: myCode(), findable: state.me.findable !== false });
    return call("code.mine", {}).then(function (b) {
      state.me = Object.assign({}, state.me || {}, { code: b.code, findable: b.findable });
      lsSet("sawa_people_cache", { uid: state.uid, me: state.me, people: state.people }); publish();
      return b;
    });
  }
  function codeErr(e) {
    var m = (e && e.message) || String(e);
    if (/bad_code/.test(m)) return L("الرمز غير صحيح — تأكّد من الأرقام العشرة", "That code isn't valid — check the 10 digits");
    if (/rate_limited/.test(m)) return L("محاولاتٌ كثيرة — انتظر قليلاً ثمّ أعد المحاولة", "Too many tries — wait a little");
    if (/too_many_pending/.test(m)) return L("لديك ٢٠ طلباً بانتظار الموافقة — ألغِ بعضها أوّلاً", "You have 20 pending requests — cancel some first");
    if (/not_found/.test(m)) return L("لا يوجد حسابٌ بهذا الرمز", "No account with this code");
    if (/bad_phone/.test(m)) return L("رقم الهاتف غير صحيح — مثال: +249912345678", "Invalid phone — e.g. +249912345678");
    if (/no_phone/.test(m)) return L("أضف رقم هاتفك أوّلاً من «حسابي»", "Add your phone number first (Me)");
    if (/no_targets/.test(m)) return L("اختر شخصاً واحداً على الأقلّ", "Pick at least one person");
    if (/not_eligible/.test(m)) return L("لتأكيد الآخرين يلزم حسابٌ بـGoogle أو بريدٍ مؤكَّد أو رقمٍ موثَّق", "To confirm others you need a Google / confirmed-email account or a verified number");
    if (/not_contact/.test(m)) return L("لستما جهتي اتّصال", "You're not contacts");
    if (/bad_email/.test(m)) return L("البريد غير صحيح", "Invalid email");
    if (/^wait$/.test(m)) return L("غيّرتَ رمزك قبل قليل — انتظر ١٠ دقائق", "You changed your code a moment ago — wait 10 minutes");
    if (/fetch|network|timeout/i.test(m)) return L("تحقّق من الاتّصال بالإنترنت", "Check your internet connection");
    return m;
  }

  // ---------- أدوات واجهةٍ صغيرة (DOM) ----------
  function mk(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function mkBtn(text, kind) {
    var css = kind === "primary" ? "background:#2e7d5b;color:#fff;border:0"
      : kind === "danger" ? "background:#fdecec;color:#b42318;border:0"
      : kind === "ghost" ? "background:transparent;color:#2F80C8;border:0"
      : "background:#fff;color:#1A1A2E;border:1.5px solid #dfe5ec";
    return mk("button", css + ";border-radius:12px;padding:12px 14px;font:800 14px system-ui;width:100%;box-sizing:border-box;cursor:pointer", text);
  }
  function sheet(title) {
    var ov = mk("div", "position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;font-family:system-ui");
    ov.dir = isAr() ? "rtl" : "ltr";
    var box = mk("div", "background:#fff;color:#1A1A2E;border-radius:20px 20px 0 0;width:100%;max-width:480px;max-height:92vh;overflow-y:auto;padding:16px 16px calc(env(safe-area-inset-bottom,0px) + 18px);box-sizing:border-box");
    box.appendChild(mk("div", "width:40px;height:4px;border-radius:2px;background:#dde3ea;margin:0 auto 12px"));
    if (title) box.appendChild(mk("div", "font:800 17px system-ui;text-align:center;margin-bottom:6px", title));
    ov.appendChild(box); document.body.appendChild(ov);
    var api = { ov: ov, box: box, close: function () { try { ov.remove(); } catch (e) {} } };
    ov.onclick = function (e) { if (e.target === ov) api.close(); };
    return api;
  }
  function note(text, color, bg) { return mk("div", "font:500 12.5px/1.7 system-ui;color:" + (color || "#5b6b7c") + ";" + (bg ? "background:" + bg + ";border-radius:10px;padding:8px 10px;" : "") + "margin:6px 0", text); }
  function avatar(name, size) {
    size = size || 52;
    return mk("div", "width:" + size + "px;height:" + size + "px;border-radius:50%;background:#e3effa;color:#2F80C8;display:flex;align-items:center;justify-content:center;font:800 " + Math.round(size * 0.42) + "px system-ui;flex-shrink:0", (name || "؟").trim().charAt(0) || "؟");
  }
  function copyText(t) {
    var done = function () { toast(L("نُسخ ✓", "Copied ✓")); };
    try { if (navigator.clipboard) return navigator.clipboard.writeText(t).then(done, function () { global.prompt(L("انسخ:", "Copy:"), t); }); } catch (e) {}
    global.prompt(L("انسخ:", "Copy:"), t);
  }
  function shareText(t) {
    try { if (NB() && NB().share) { NB().share("سوا", t); return Promise.resolve(); } } catch (e) {}   // C84: WebView لا يعرف navigator.share
    try { if (navigator.share) return navigator.share({ title: "سوا", text: t }).catch(function () {}); } catch (e) {}
    copyText(t);
  }
  function codeBig(c) {
    var el = mk("div", "font:800 30px/1.3 ui-monospace,Menlo,monospace;letter-spacing:2px;text-align:center;direction:ltr;color:#1A1A2E;background:#f3f7fb;border-radius:16px;padding:14px 8px;margin:8px 0", c ? fmtCode(c) : "… … …");
    el.className = "sawa-code-big";
    return el;
  }

  // ---------- طلبات التواصل ----------
  var reqs = { incoming: [], outgoing: [], vouches: [], at: 0 };
  function publishReqs() {
    try { global.dispatchEvent(new CustomEvent("sawa-requests", { detail: reqs.incoming.length + (reqs.vouches || []).length })); } catch (e) {}
  }
  function loadRequests(pre) {
    if (!state.uid) return Promise.resolve(reqs);
    return (pre ? Promise.resolve(pre) : call("code.requests", {})).then(function (b) {
      reqs = { incoming: b.incoming || [], outgoing: b.outgoing || [], vouches: b.vouches || [], at: Date.now() };
      publishReqs(); return reqs;
    }).catch(function (e) { log("requests:", (e && e.message) || e); return reqs; });
  }
  function respond(from, action) {
    return call("code.respond", { from: from, action: action }).then(function (b) {
      reqs.incoming = reqs.incoming.filter(function (r) { return r.uid !== from; }); publishReqs();
      if (action === "accept") {
        toast(L("أصبحتما جهتي اتّصال ✓", "You're now connected ✓"));
        refresh();
        if (b.cid) whenApp(function () { setTimeout(function () { try { if (app.openChatById) app.openChatById(b.cid); } catch (e) {} }, 900); });
      } else if (action === "block") { toast(L("حُظر ولن تصلك طلباته ✓", "Blocked ✓")); loadPrefs(); }
      else toast(L("رُفض الطلب", "Request declined"));
      return b;
    }).catch(function (e) { toast(codeErr(e)); return null; });
  }
  function timeAgo(ts) {
    if (!ts) return "";
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return L("الآن", "now");
    if (m < 60) return L("قبل " + m + " د", m + "m ago");
    var h = Math.round(m / 60); if (h < 24) return L("قبل " + h + " س", h + "h ago");
    return new Date(ts).toLocaleDateString(isAr() ? "ar" : "en");
  }
  function requestsSheet() {
    if (!state.uid) return false;
    var s = sheet(L("طلبات التواصل", "Contact requests"));
    var list = mk("div", "margin-top:6px"); s.box.appendChild(list);
    list.appendChild(note(L("جارٍ التحميل…", "Loading…")));
    function row(r, incoming) {
      var card = mk("div", "border:1px solid #e6ebf0;border-radius:14px;padding:12px;margin:8px 0");
      var top = mk("div", "display:flex;gap:10px;align-items:center");
      top.appendChild(avatar(r.name, 42));
      var info = mk("div", "flex:1;min-width:0");
      info.appendChild(mk("div", "font:800 15px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", r.name || L("مستخدم سوا", "Sawa user")));
      info.appendChild(mk("div", "font:500 11px system-ui;color:#8796a5;direction:ltr;text-align:" + (isAr() ? "right" : "left"), (r.code ? fmtCode(r.code) + " · " : "") + timeAgo(r.ts)));
      top.appendChild(info); card.appendChild(top);
      if (incoming && r.text) card.appendChild(mk("div", "font:500 14px/1.7 system-ui;background:#f5f8fb;border-radius:10px;padding:8px 10px;margin-top:8px;white-space:pre-wrap;word-break:break-word", r.text));
      var acts = mk("div", "display:flex;gap:8px;margin-top:10px");
      function act(label, kind, fn) { var b = mkBtn(label, kind); b.style.padding = "9px 8px"; b.style.fontSize = "13px"; b.onclick = function () { b.disabled = true; b.textContent = "…"; fn(); }; acts.appendChild(b); }
      if (incoming) {
        act(L("قبول", "Accept"), "primary", function () { respond(r.uid, "accept").then(function () { s.close(); }); });
        act(L("رفض", "Decline"), "", function () { respond(r.uid, "reject").then(draw); });
        act(L("حظر", "Block"), "danger", function () { respond(r.uid, "block").then(draw); });
      } else {
        acts.appendChild(mk("div", "flex:2;align-self:center;font:600 12px system-ui;color:#8796a5", L("بانتظار موافقته…", "Waiting for them to accept…")));
        act(L("إلغاء الطلب", "Cancel"), "", function () {
          call("code.cancel", { to: r.uid }).then(function () { reqs.outgoing = reqs.outgoing.filter(function (x) { return x.uid !== r.uid; }); draw(); })
            .catch(function (e) { toast(codeErr(e)); draw(); });
        });
      }
      card.appendChild(acts);
      return card;
    }
    // C44: بطاقة «هل هذا رقم فلان؟»
    function vouchRow(r) {
      var card = mk("div", "border:1.5px solid #bfe0d2;background:#f3faf6;border-radius:14px;padding:12px;margin:8px 0");
      var top = mk("div", "display:flex;gap:10px;align-items:center");
      top.appendChild(avatar(r.name, 42));
      var info = mk("div", "flex:1;min-width:0");
      info.appendChild(mk("div", "font:800 15px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", r.name || L("مستخدم سوا", "Sawa user")));
      info.appendChild(mk("div", "font:700 14px system-ui;color:#187854;direction:ltr;text-align:" + (isAr() ? "right" : "left"), r.phone || ""));
      top.appendChild(info); card.appendChild(top);
      card.appendChild(mk("div", "font:600 13px/1.6 system-ui;margin-top:8px", L("يطلب تأكيد أنّ هذا رقمه. هل هو رقمه الذي تعرفه؟", "Asks you to confirm this is their number. Is it the number you know?")));
      var st = mk("div", "font:600 12px system-ui;min-height:16px;margin-top:4px;color:#8796a5"); card.appendChild(st);
      var acts = mk("div", "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap");
      function act(label, kind, fn) { var b = mkBtn(label, kind); b.style.padding = "9px 8px"; b.style.fontSize = "13px"; b.style.flex = "1"; b.onclick = function () { b.disabled = true; b.textContent = "…"; fn(b, label); }; acts.appendChild(b); return b; }
      function answer(ok, matched) {
        return call("vouch.respond", { for: r.uid, ok: ok, matched: !!matched }).then(function (b) {
          reqs.vouches = reqs.vouches.filter(function (x) { return x.uid !== r.uid; }); publishReqs();
          if (!ok) toast(L("حسناً — لم يُحتسب", "OK — not counted"));
          else if (b.stale) toast(L("غيّر رقمه — انتهى الطلب", "They changed their number — request expired"));
          else if (b.verified) toast(L("تأكّد رقمه ✓ شكراً", "Their number is now confirmed ✓ thanks"));
          else if (b.conflict) toast(L("هذا الرقم موثَّق لحسابٍ آخر", "This number is verified on another account"));
          else toast(L("شكراً — أُحتسب تأكيدك (" + b.count + "/" + b.needed + ")", "Thanks — counted (" + b.count + "/" + b.needed + ")"));
          draw();
        }).catch(function (e) { toast(codeErr(e)); draw(); });
      }
      var yes = act(L("نعم، هذا رقمه", "Yes, that's their number"), "primary", function () { answer(true, false); });
      act(L("لست متأكّداً", "Not sure"), "", function () { answer(false); });
      // مقارنة بدفتر الهاتف (Chrome أندرويد: Contact Picker)
      try {
        if (global.navigator && navigator.contacts && navigator.contacts.select) {
          var cmp = mkBtn(L("📒 قارن بدفتر هاتفي", "📒 Compare with my phonebook")); cmp.style.width = "100%"; cmp.style.marginTop = "6px";
          cmp.onclick = function () {
            navigator.contacts.select(["tel", "name"], { multiple: false }).then(function (cs) {
              var c = cs && cs[0]; if (!c) return;
              var norm = function (x) { var d = String(x || "").replace(/[^\d+]/g, ""); if (d.indexOf("00") === 0) d = "+" + d.slice(2); if (/^0\d{9}$/.test(d)) d = "+249" + d.slice(1); return d; };
              var want = norm(r.phone), got = (c.tel || []).map(norm);
              if (got.indexOf(want) >= 0) { st.textContent = L("✓ مطابقٌ لدفترك", "✓ Matches your phonebook"); st.style.color = "#187854"; yes.disabled = true; yes.textContent = "…"; answer(true, true); }
              else { st.textContent = L("الرقم في دفترك مختلف: ", "Your phonebook has: ") + (got[0] || "—") + L(" — لا تؤكّد إلّا إن كنت متأكّداً.", " — confirm only if you're sure."); st.style.color = "#b42318"; }
            }).catch(function () {});
          };
          card.appendChild(acts); card.appendChild(cmp); return card;
        }
      } catch (e) {}
      card.appendChild(acts);
      return card;
    }
    function draw() {
      list.innerHTML = "";
      var vs = reqs.vouches || [];
      if (!reqs.incoming.length && !reqs.outgoing.length && !vs.length) list.appendChild(note(L("لا طلبات الآن. شارك رمزك ليصلك من يعرفك.", "No requests. Share your code so people can reach you.")));
      if (vs.length) { list.appendChild(mk("div", "font:800 13px system-ui;color:#5b6b7c;margin-top:8px", L("تأكيد رقم", "Number confirmation") + " (" + vs.length + ")")); vs.forEach(function (r) { list.appendChild(vouchRow(r)); }); }
      if (reqs.incoming.length) { list.appendChild(mk("div", "font:800 13px system-ui;color:#5b6b7c;margin-top:8px", L("وصلتك", "Received") + " (" + reqs.incoming.length + ")")); reqs.incoming.forEach(function (r) { list.appendChild(row(r, true)); }); }
      if (reqs.outgoing.length) { list.appendChild(mk("div", "font:800 13px system-ui;color:#5b6b7c;margin-top:12px", L("أرسلتَها", "Sent") + " (" + reqs.outgoing.length + ")")); reqs.outgoing.forEach(function (r) { list.appendChild(row(r, false)); }); }
      var foot = mk("div", "display:flex;gap:8px;margin-top:12px");
      var b1 = mkBtn(L("🔢 أدخل رمز شخص", "🔢 Enter a code")); b1.onclick = function () { s.close(); findSheet(); };
      var b2 = mkBtn(L("رمزي", "My code")); b2.onclick = function () { s.close(); codeSheet(); };
      foot.appendChild(b1); foot.appendChild(b2); list.appendChild(foot);
      list.appendChild(note(L("الرفض لا يُبلَّغ للمرسل. والحظر يمنع طلباته ورسائله.", "Declining isn't shown to the sender. Blocking stops their requests and messages.")));
    }
    loadRequests().then(draw);
    return true;
  }

  // ---------- «أدخل رمز شخص» ----------
  function findSheet(prefill) {
    if (!state.uid) { toast(L("جارٍ الاتّصال بالخادم…", "Connecting…")); return false; }
    var s = sheet(L("أضف شخصاً", "Add someone"));
    // C43: طرق البحث — الرمز (دائماً) · الهاتف الموثَّق · البريد الموثَّق
    var mode = "code";
    var seg = mk("div", "display:flex;gap:6px;margin:0 0 10px;background:#f1f5f9;border-radius:12px;padding:4px");
    var segBtns = {};
    [["code", L("رمز سوا", "Code")], ["phone", L("رقم الهاتف", "Phone")], ["email", L("البريد", "Email")]].forEach(function (x) {
      var b = mk("button", "flex:1;border:0;border-radius:9px;padding:8px 4px;font:700 12.5px system-ui;background:transparent;color:#5b6b7c", x[1]);
      b.onclick = function () { setMode(x[0]); }; segBtns[x[0]] = b; seg.appendChild(b);
    });
    s.box.appendChild(seg);
    var intro = note(""); s.box.appendChild(intro);
    var inp = mk("input", "width:100%;box-sizing:border-box;border:1.5px solid #dfe5ec;color:#1A1A2E;background:#fff;border-radius:14px;padding:13px;font:800 24px ui-monospace,Menlo,monospace;letter-spacing:2px;text-align:center;direction:ltr;outline:none");
    inp.setAttribute("inputmode", "numeric"); inp.setAttribute("autocomplete", "off"); inp.placeholder = "000 000 0000";
    s.box.appendChild(inp);
    var hint = mk("div", "font:600 12px system-ui;min-height:18px;margin:6px 2px;text-align:center"); s.box.appendChild(hint);
    var go = mkBtn(L("بحث", "Search"), "primary"); s.box.appendChild(go);
    var res = mk("div", "margin-top:12px"); s.box.appendChild(res);
    function setMode(m) {
      mode = m; res.innerHTML = ""; inp.value = "";
      Object.keys(segBtns).forEach(function (k) { segBtns[k].style.background = k === m ? "#fff" : "transparent"; segBtns[k].style.color = k === m ? "#1A1A2E" : "#5b6b7c"; segBtns[k].style.boxShadow = k === m ? "0 1px 3px rgba(0,0,0,.12)" : "none"; });
      if (m === "code") { intro.textContent = L("اطلب من الشخص رمزه (في «حسابي» عنده) واكتبه هنا — ١٠ أرقام.", "Ask for their code (in their «Me» tab) and type it here — 10 digits."); inp.setAttribute("inputmode", "numeric"); inp.type = "text"; inp.placeholder = "000 000 0000"; inp.style.font = "800 24px ui-monospace,Menlo,monospace"; inp.style.letterSpacing = "2px"; }
      else if (m === "phone") { intro.textContent = L("يُعثر على من وثّق رقمه عبر واتساب فقط. اكتب الرقم بالصيغة الدوليّة أو المحلّيّة.", "Finds only people who verified their number via WhatsApp. International or local format."); inp.setAttribute("inputmode", "tel"); inp.type = "tel"; inp.placeholder = "+249 9X XXX XXXX"; inp.style.font = "700 18px system-ui"; inp.style.letterSpacing = "0"; }
      else { intro.textContent = L("يُعثر على أصحاب حسابات Google أو البريد المؤكَّد الذين لم يخفوا أنفسهم.", "Finds people with a Google or confirmed email account who haven't hidden themselves."); inp.setAttribute("inputmode", "email"); inp.type = "email"; inp.placeholder = "name@example.com"; inp.style.font = "700 16px system-ui"; inp.style.letterSpacing = "0"; }
      inp.style.direction = "ltr"; sync();
    }
    function sync() {
      if (mode !== "code") {
        var v = inp.value.trim(), okv = mode === "phone" ? /^\+?[\d\s()-]{8,}$/.test(v) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        hint.textContent = ""; go.disabled = !okv; go.style.opacity = okv ? "1" : ".5"; return okv ? v : null;
      }
      var d = codeDigits(inp.value).slice(0, 10), f = fmtCode(d);
      if (inp.value !== f) inp.value = f;
      var ok = d.length === 10 && codeValid(d);
      hint.style.color = d.length === 10 && !ok ? "#b42318" : "#8796a5";
      hint.textContent = d.length < 10 ? (d.length ? L("بقي " + (10 - d.length) + " أرقام", (10 - d.length) + " digits left") : "")
        : ok ? "✓" : L("الرمز غير صحيح — تأكّد من الأرقام", "Invalid code — check the digits");
      go.disabled = !ok; go.style.opacity = ok ? "1" : ".5";
      return ok ? d : null;
    }
    inp.oninput = function () { res.innerHTML = ""; sync(); };
    inp.onkeydown = function (e) { if (e.key === "Enter" && !go.disabled) go.onclick(); };
    function card(b) {
      res.innerHTML = "";
      var c = mk("div", "border:1px solid #e6ebf0;border-radius:16px;padding:14px;text-align:center");
      if (!b.found) { c.appendChild(note(L("لا يوجد حسابٌ بهذا الرمز. ربّما غيّر صاحبه رمزه أو أخفاه — اطلب منه رمزه الحاليّ.", "No account with this code. It may have been changed or hidden."), "#8a5a00")); res.appendChild(c); return; }
      var a = avatar(b.name, 64); a.style.margin = "0 auto 8px"; c.appendChild(a);
      c.appendChild(mk("div", "font:800 18px system-ui", b.name || L("مستخدم سوا", "Sawa user")));
      c.appendChild(mk("div", "font:600 12px system-ui;color:#8796a5;direction:ltr;margin:2px 0 10px", b.code ? fmtCode(b.code) : ""));
      if (b.self) { c.appendChild(note(L("هذا رمزك أنت 🙂", "That's your own code 🙂"))); res.appendChild(c); return; }
      if (b.contact) {
        c.appendChild(note(L("جهة اتّصالك ✓", "Already a contact ✓"), "#2e7d5b"));
        var m = mkBtn(L("مراسلة", "Message"), "primary");
        m.onclick = function () { openDm(b.uid).then(function (cid) { if (cid) whenApp(function () { try { app.openChatById(cid); } catch (e) {} }); s.close(); }); };
        c.appendChild(m);
        // C62: اتصال مباشر من بطاقة الرمز (لوحة الأرقام تصل إلى هنا)
        var R = global.SawaRTC;
        if (R && R.enabled && R.enabled()) {
          var cr = mk("div", "display:flex;gap:8px;margin-top:8px");
          var ca = mkBtn("📞 " + L("اتصال", "Call")), cv = mkBtn("📹 " + L("فيديو", "Video")); ca.style.flex = cv.style.flex = "1";
          ca.onclick = function () { s.close(); R.call(b.uid, b.name, "audio"); }; cv.onclick = function () { s.close(); R.call(b.uid, b.name, "video"); };
          cr.appendChild(ca); cr.appendChild(cv); c.appendChild(cr);
        }
        res.appendChild(c); return;
      }
      if (b.pending === "in") {
        c.appendChild(note(L("أرسل لك طلب تواصل.", "They sent you a request."), "#2F80C8"));
        var acc = mkBtn(L("قبول الطلب", "Accept"), "primary");
        acc.onclick = function () { acc.disabled = true; respond(b.uid, "accept").then(function () { s.close(); }); };
        c.appendChild(acc); res.appendChild(c); return;
      }
      if (b.pending === "out") {
        c.appendChild(note(L("أرسلتَ له طلباً — بانتظار موافقته.", "Request sent — waiting for them."), "#8796a5"));
        var cn = mkBtn(L("إلغاء الطلب", "Cancel request"));
        cn.onclick = function () { cn.disabled = true; call("code.cancel", { to: b.uid }).then(function () { toast(L("أُلغي الطلب", "Cancelled")); s.close(); }, function (e) { toast(codeErr(e)); cn.disabled = false; }); };
        c.appendChild(cn); res.appendChild(c); return;
      }
      var myN = (state.me && state.me.name) || "";
      var ta = mk("textarea", "width:100%;box-sizing:border-box;border:1px solid #dfe5ec;color:#1A1A2E;background:#fff;border-radius:12px;padding:10px;font:500 14px/1.6 system-ui;min-height:64px;resize:vertical;margin-top:4px");
      ta.maxLength = 300; ta.value = myN ? L("السلام عليكم، أنا " + myN + " 👋", "Hi, it's " + myN + " 👋") : L("السلام عليكم 👋", "Hi 👋");
      c.appendChild(mk("div", "font:700 12px system-ui;color:#5b6b7c;text-align:" + (isAr() ? "right" : "left") + ";margin-top:4px", L("رسالة تعريف (يقرؤها قبل أن يوافق)", "Intro message (they see it before accepting)")));
      c.appendChild(ta);
      var snd = mkBtn(L("إرسال طلب تواصل", "Send request"), "primary"); snd.style.marginTop = "10px"; c.appendChild(snd);
      c.appendChild(note(L("لن تستطيعا المراسلة أو الاتّصال حتّى يقبل طلبك.", "You can't message or call until they accept.")));
      snd.onclick = function () {
        snd.disabled = true; snd.textContent = "…";
        call("code.request", { code: b.code, text: ta.value }).then(function (r) {
          if (r.accepted) { toast(L("أصبحتما جهتي اتّصال ✓", "You're now connected ✓")); refresh(); loadRequests();
            if (r.cid) whenApp(function () { setTimeout(function () { try { app.openChatById(r.cid); } catch (e) {} }, 900); }); s.close(); return; }
          if (r.already) { card({ found: true, contact: true, uid: r.uid, name: b.name, code: b.code }); return; }
          toast(L("أُرسل الطلب ✓ — ستُبلَّغ حين يوافق", "Request sent ✓")); loadRequests(); s.close();
        }).catch(function (e) { snd.disabled = false; snd.textContent = L("إرسال طلب تواصل", "Send request"); toast(codeErr(e)); });
      };
      res.appendChild(c);
    }
    go.onclick = function () {
      var d = sync(); if (!d) return;
      go.disabled = true; go.textContent = "…";
      var q = mode === "code" ? call("code.find", { code: d }) : mode === "phone" ? call("find.phone", { phone: d }) : call("find.email", { email: d });
      q.then(function (b) { if (!b.found && mode !== "code") { res.innerHTML = ""; res.appendChild(note(mode === "phone" ? L("لا أحد بهذا الرقم — ربّما لم يوثّقه صاحبه بعد، أو أخفى نفسه. اطلب رمزه بدلاً.", "Nobody with this number — maybe not verified yet, or hidden. Ask for their code instead.") : L("لا أحد بهذا البريد — ربّما يدخل بطريقةٍ أخرى أو أخفى نفسه. اطلب رمزه بدلاً.", "Nobody with this email — maybe they sign in differently, or hid themselves. Ask for their code instead."))); return; } card(b); },
        function (e) { res.innerHTML = ""; res.appendChild(note(codeErr(e), "#b42318")); })
        .then(function () { go.disabled = false; go.textContent = L("بحث", "Search"); });
    };
    setMode("code");
    if (prefill) { inp.value = prefill; if (sync()) go.onclick(); } else sync();
    setTimeout(function () { try { if (!prefill) inp.focus(); } catch (e) {} }, 60);
    return true;
  }

  // ---------- C43: توثيق الرقم عبر واتساب ----------
  //  phone.start ⇒ رمز SAWA-XXXXXX ورابط wa.me برقم سوا · المستخدم يرسله من واتسابه · Meta ⇒ Worker /wa/webhook ⇒ phoneVerified
  //  الرقم الذي أرسل الرمز هو الذي يُوثَّق (حتّى لو كتب رقماً آخر). الورقة تستطلع phone.status كلّ ٣ ثوانٍ.
  function verifySheet() {
    if (!state.uid) { toast(L("جارٍ الاتّصال بالخادم…", "Connecting…")); return false; }
    var p = profile();
    if (p.phoneVerified) { toast(L("رقمك موثَّق ✓", "Your number is verified ✓")); return true; }
    var s = sheet(L("توثيق رقمك", "Verify your number"));
    if (!p.phone) { s.box.appendChild(note(L("أضف رقم هاتفك أوّلاً من «حسابي» ← القلم.", "Add your phone number first (Me → pencil)."), "#8a6d00", "#fff7e0")); var ab = mkBtn(L("أضف رقمي", "Add my number"), "primary"); ab.onclick = function () { s.close(); editProfile(); }; s.box.appendChild(ab); return true; }
    var body = mk("div"); s.box.appendChild(body);
    var timer = null, stopPoll = function () { if (timer) { clearInterval(timer); timer = null; } };
    var origClose = s.close; s.close = function () { stopPoll(); origClose(); };
    // C44: الشاشة الأولى — «عبر معارفك» دائماً، و«عبر واتساب» إن كان الخادم مهيّأً
    function home() {
      body.innerHTML = "";
      body.appendChild(mk("div", "font:600 13px system-ui;color:#5b6b7c;direction:ltr;text-align:center;margin:2px 0 8px", p.phone));
      body.appendChild(note(L("جارٍ التحميل…", "Loading…")));
      Promise.all([call("phone.status", {}), call("profile.get", {}).catch(function () { return {}; })]).then(function (rr) {
        var st = rr[0] || {}, wa = !!(rr[1] && rr[1].verify && rr[1].verify.whatsapp);
        state.waReady = wa;
        body.innerHTML = "";
        body.appendChild(mk("div", "font:600 13px system-ui;color:#5b6b7c;direction:ltr;text-align:center;margin:2px 0 8px", p.phone));
        if (st.phoneVerified) { state.me = Object.assign({}, state.me || {}, { phoneVerified: true, verifiedBy: st.verifiedBy || "whatsapp" }); publish(); try { if (app && app.setMyProfile) app.setMyProfile(profile()); } catch (e) {} body.appendChild(note(L("رقمك موثَّق ✓", "Verified ✓"), "#187854", "#e8f5ee")); return; }
        // ١) عبر المعارف
        var c1 = mk("div", "border:1px solid #e6ebf0;border-radius:16px;padding:12px;margin:8px 0");
        c1.appendChild(mk("div", "font:800 15px system-ui", L("👥 عبر معارفك", "👥 Through people you know")));
        c1.appendChild(note(L("اطلب من اثنين من جهات اتّصالك (بحساب Google أو بريدٍ مؤكَّد) أن يؤكّدا أنّ هذا رقمك. بلا رسائل ولا تكلفة.", "Ask two of your contacts (with a Google or confirmed-email account) to confirm this is your number. No messages, no cost.")));
        var n = st.vouches || 0, need = st.needed || 2;
        var bar = mk("div", "display:flex;align-items:center;gap:8px;margin:6px 0");
        for (var i = 0; i < need; i++) bar.appendChild(mk("div", "flex:1;height:8px;border-radius:4px;background:" + (i < n ? "#187854" : "#e6ebf0")));
        bar.appendChild(mk("div", "font:800 12px system-ui;color:#5b6b7c;white-space:nowrap", n + " / " + need));
        c1.appendChild(bar);
        if (st.vouchers && st.vouchers.length) c1.appendChild(note(L("أكّد: ", "Confirmed by: ") + st.vouchers.filter(Boolean).join("، "), "#187854"));
        var ask = mkBtn(L("اطلب من معارفك", "Ask my contacts"), "primary"); c1.appendChild(ask);
        ask.onclick = function () { pickVouchers(function () { home(); }); };
        body.appendChild(c1);
        // ٢) عبر واتساب
        var c2 = mk("div", "border:1px solid #e6ebf0;border-radius:16px;padding:12px;margin:8px 0");
        c2.appendChild(mk("div", "font:800 15px system-ui", L("💬 عبر واتساب", "💬 Via WhatsApp")));
        if (wa) { c2.appendChild(note(L("ترسل رمزاً قصيراً إلى رقم سوا على واتساب فيُوثَّق رقمك فوراً.", "Send a short code to Sawa's WhatsApp and your number is verified instantly."))); var g2 = mkBtn(L("ابدأ — افتح واتساب", "Start — open WhatsApp")); g2.onclick = intro; c2.appendChild(g2); }
        else c2.appendChild(note(L("قيد التجهيز — سيُفعَّل قريباً.", "Coming soon."), "#8a6d00", "#fff7e0"));
        body.appendChild(c2);
      }).catch(function (e) { body.innerHTML = ""; body.appendChild(note(codeErr(e), "#b42318")); });
    }
    // اختيار المعارف (حتى ٥)
    function pickVouchers(done) {
      var ppl = (state.people || []).filter(function (x) { return !x.anon; });
      var s2 = sheet(L("من يؤكّد رقمك؟", "Who can confirm your number?"));
      if (!ppl.length) { s2.box.appendChild(note(L("لا جهات اتّصال بعد — أضف معارفك أوّلاً.", "No contacts yet — add people first."))); return; }
      s2.box.appendChild(note(L("اختر حتى ٥ أشخاص يعرفون رقمك. يصلهم طلبٌ بسيط: «هل هذا رقم فلان؟».", "Pick up to 5 people who know your number. They get a simple question: “Is this their number?”.")));
      var chosen = {}, list = mk("div", "max-height:50vh;overflow-y:auto;margin:6px 0");
      ppl.slice(0, 200).forEach(function (x) {
        var row = mk("button", "width:100%;display:flex;align-items:center;gap:10px;padding:8px 6px;border:0;border-bottom:1px solid #eef2f6;background:transparent;text-align:start;font:600 14px system-ui;color:#1A1A2E");
        var cb = mk("span", "width:22px;height:22px;border-radius:7px;border:2px solid #cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-size:14px;flex:none");
        row.appendChild(cb); row.appendChild(avatar(x.name, 34)); row.appendChild(mk("span", "flex:1", x.name || L("مستخدم سوا", "Sawa user")));
        row.onclick = function () { if (chosen[x.uid]) delete chosen[x.uid]; else { if (Object.keys(chosen).length >= 5) { toast(L("خمسة كحدٍّ أقصى", "Five at most")); return; } chosen[x.uid] = 1; } cb.textContent = chosen[x.uid] ? "✓" : ""; cb.style.background = chosen[x.uid] ? "#187854" : "transparent"; cb.style.color = "#fff"; cb.style.borderColor = chosen[x.uid] ? "#187854" : "#cbd5e1"; snd.disabled = !Object.keys(chosen).length; };
        list.appendChild(row);
      });
      s2.box.appendChild(list);
      var snd = mkBtn(L("إرسال الطلب", "Send request"), "primary"); snd.disabled = true; s2.box.appendChild(snd);
      snd.onclick = function () {
        snd.disabled = true; snd.textContent = "…";
        call("vouch.request", { to: Object.keys(chosen) }).then(function (r) {
          if (r.already) { toast(L("رقمك موثَّق أصلاً ✓", "Already verified ✓")); s2.close(); done(); return; }
          toast(r.sent ? L("أُرسل الطلب إلى " + r.sent + " — سنبلغك حين يؤكّدوا", "Sent to " + r.sent + " — we'll tell you when they confirm") : L("لم يُرسَل — اختر جهات اتّصال متبادلة", "Not sent — pick mutual contacts"));
          s2.close(); done();
        }).catch(function (e) { snd.disabled = false; snd.textContent = L("إرسال الطلب", "Send request"); toast(codeErr(e)); });
      };
    }
    function intro() {
      body.innerHTML = "";
      body.appendChild(note(L("لا نرسل لك رسالة SMS — أنت الذي ترسل رمزاً قصيراً إلى رقم سوا على واتساب، فنعرف رقمك من واتساب نفسه. مجّاناً وفي ثوانٍ.",
        "No SMS needed — you send a short code to Sawa's WhatsApp number, and we learn your number from WhatsApp itself. Free, in seconds.")));
      body.appendChild(note(L("يُوثَّق الرقم الذي ترسل منه الرمز، ويحلّ محلّ الرقم المكتوب في حسابك إن اختلف.", "The number you send from is the one verified; it replaces the typed one if different."), "#8a6d00", "#fff7e0"));
      var go = mkBtn(L("ابدأ — افتح واتساب", "Start — open WhatsApp"), "primary"); go.style.marginTop = "10px"; body.appendChild(go);
      go.onclick = function () {
        go.disabled = true; go.textContent = "…";
        call("phone.start", {}).then(function (r) {
          if (!r.enabled) { state.waReady = false; body.innerHTML = ""; body.appendChild(note(L("التحقّق عبر واتساب قيد التجهيز — سيُفعَّل قريباً، وسنبلغك.", "WhatsApp verification is being set up — coming soon."), "#8a6d00", "#fff7e0")); return; }
          state.waReady = true; stage(r);
        }, function (e) { go.disabled = false; go.textContent = L("ابدأ — افتح واتساب", "Start — open WhatsApp"); toast(codeErr(e)); });
      };
    }
    function stage(r) {
      body.innerHTML = "";
      body.appendChild(note(L("١) يفتح واتساب برسالة جاهزة فيها الرمز — اضغط «إرسال» فقط.\n٢) عد إلى سوا؛ نتحقّق تلقائيّاً خلال ثوانٍ.", "1) WhatsApp opens with the code ready — just tap Send.\n2) Come back to Sawa; we verify automatically in seconds.")));
      var codeEl = mk("div", "font:800 26px ui-monospace,Menlo,monospace;letter-spacing:3px;text-align:center;direction:ltr;background:#f1f5f9;border-radius:14px;padding:12px;margin:8px 0", "SAWA-" + r.code);
      body.appendChild(codeEl);
      var open = mkBtn(L("📲 افتح واتساب وأرسل الرمز", "📲 Open WhatsApp and send the code"), "primary"); body.appendChild(open);
      var st = note(L("بانتظار رسالتك…", "Waiting for your message…"), "#8796a5"); st.style.textAlign = "center"; body.appendChild(st);
      var cp = mkBtn(L("نسخ الرمز (إن لم يفتح واتساب)", "Copy the code (if WhatsApp didn't open)")); body.appendChild(cp);
      cp.onclick = function () { copyText("SAWA-" + r.code); toast(L("نُسخ — أرسله إلى واتساب سوا", "Copied — send it to Sawa's WhatsApp")); };
      open.onclick = function () { try { global.open(r.link, "_blank"); } catch (e) { global.location.href = r.link; } };
      open.onclick();
      var n = 0;
      stopPoll();
      timer = setInterval(function () {
        n++;
        if (Date.now() > r.exp || n > 100) { stopPoll(); st.textContent = L("انتهت صلاحيّة الرمز — اطلب رمزاً جديداً.", "Code expired — request a new one."); st.style.color = "#b42318"; var again = mkBtn(L("رمز جديد", "New code"), "primary"); again.onclick = intro; body.appendChild(again); return; }
        if (document.visibilityState !== "visible" && n % 5) return;
        call("phone.status", {}).then(function (q) {
          if (!q.phoneVerified) return;
          stopPoll();
          state.me = Object.assign({}, state.me || {}, { phone: q.phone, phoneVerified: true, verifiedBy: q.verifiedBy || "whatsapp" });
          lsSet("sawa_people_cache", { uid: state.uid, me: state.me, people: state.people });
          publish(); try { if (app && app.setMyProfile) app.setMyProfile(profile()); } catch (e) {}
          toast(L("تمّ توثيق رقمك ✓ " + q.phone, "Number verified ✓ " + q.phone));
          s.close();
        }).catch(function () {});
      }, 3000);
    }
    home();
    return true;
  }
  // ---------- «رمزي في سوا» ----------
  function codeSheet() {
    if (!state.uid) { toast(L("جارٍ الاتّصال بالخادم…", "Connecting…")); return false; }
    var s = sheet(L("رمزك في سوا", "Your Sawa code"));
    var big = codeBig(myCode()); s.box.appendChild(big);
    s.box.appendChild(note(L("أعطه لمن تريد أن يتواصل معك. يرى اسمك فقط — لا بريدك ولا رقمك — ويرسل لك طلباً، ولا يراسلك قبل أن تقبل.",
      "Give it to people you want to hear from. They see your name only and send a request — no messages until you accept.")));
    var row = mk("div", "display:flex;gap:8px;margin:8px 0");
    var cp = mkBtn(L("نسخ", "Copy")), sh = mkBtn(L("مشاركة", "Share"), "primary");
    row.appendChild(cp); row.appendChild(sh); s.box.appendChild(row);
    var qrBtn = mkBtn(L("عرض رمز QR", "Show QR"), "ghost"); s.box.appendChild(qrBtn);
    var qr = mk("div", "display:none;justify-content:center;margin:8px 0"); var qrIn = mk("div", "background:#fff;padding:8px;border-radius:12px"); qr.appendChild(qrIn); s.box.appendChild(qr);
    var sep = mk("div", "height:1px;background:#eef1f4;margin:12px 0"); s.box.appendChild(sep);
    var tg = mk("label", "display:flex;align-items:center;gap:10px;font:700 14px system-ui;padding:6px 2px;cursor:pointer");
    var cb = mk("input"); cb.type = "checkbox"; cb.style.cssText = "width:20px;height:20px";
    tg.appendChild(cb); tg.appendChild(mk("span", "flex:1", L("يجدني الآخرون برمزي", "People can find me by my code"))); s.box.appendChild(tg);
    var reset = mkBtn(L("تغيير رمزي", "Change my code")); reset.style.marginTop = "8px"; s.box.appendChild(reset);
    s.box.appendChild(note(L("غيّره إن انتشر رمزك أكثر ممّا تريد — القديم يتوقّف فوراً، وجهات اتّصالك الحاليّة لا تتأثّر.", "Change it if it spread too far — the old one stops working; existing contacts stay.")));
    function fill(b) {
      big.textContent = fmtCode(b.code); cb.checked = b.findable !== false;
      cp.onclick = function () { copyText(fmtCode(b.code)); };
      sh.onclick = function () { shareText(codeShareText(b.code)); };
      qrBtn.onclick = function () {
        qr.style.display = "flex"; qrBtn.style.display = "none";
        loadQrLib().then(function (Q) { qrIn.innerHTML = ""; new Q(qrIn, { text: codeUrl(b.code), width: 200, height: 200, colorDark: "#1A1A2E", colorLight: "#FFFFFF", correctLevel: Q.CorrectLevel.M }); })
          .catch(function (e) { qrIn.textContent = (e && e.message) || String(e); });
      };
    }
    cb.onchange = function () {
      var v = cb.checked;
      call("code.privacy", { findable: v }).then(function () {
        state.me = Object.assign({}, state.me || {}, { findable: v }); lsSet("sawa_people_cache", { uid: state.uid, me: state.me, people: state.people });
        toast(v ? L("يمكن العثور عليك برمزك ✓", "Findable by code ✓") : L("لن يجدك أحدٌ برمزك", "Hidden from code search"));
      }).catch(function (e) { cb.checked = !v; toast(codeErr(e)); });
    };
    reset.onclick = function () {
      if (!global.confirm(L("تغيير رمزك؟ الرمز القديم يتوقّف فوراً.", "Change your code? The old one stops working."))) return;
      reset.disabled = true;
      call("code.reset", {}).then(function (b) {
        state.me = Object.assign({}, state.me || {}, { code: b.code, findable: b.findable }); lsSet("sawa_people_cache", { uid: state.uid, me: state.me, people: state.people });
        publish(); fill(b); qr.style.display = "none"; qrBtn.style.display = ""; toast(L("رمزك الجديد جاهز ✓", "New code ready ✓"));
      }).catch(function (e) { toast(codeErr(e)); }).then(function () { reset.disabled = false; });
    };
    loadCode().then(fill).catch(function (e) { big.textContent = "—"; toast(codeErr(e)); });
    return true;
  }

  // ---------- الدخول بالبريد الإلكتروني ----------
  function emailErr(e) {
    var c = (e && e.code) || "";
    var map = {
      "auth/email-already-in-use": L("هذا البريد مسجّلٌ سلفاً — اختر «لديّ حساب»", "This email is already registered — choose «I have an account»"),
      "auth/credential-already-in-use": L("هذا البريد مسجّلٌ سلفاً — اختر «لديّ حساب»", "This email is already registered"),
      "auth/invalid-email": L("البريد غير صحيح", "Invalid email"),
      "auth/missing-email": L("اكتب بريدك", "Enter your email"),
      "auth/weak-password": L("كلمة المرور قصيرة — ٦ أحرف على الأقلّ", "Password too short — at least 6 characters"),
      "auth/missing-password": L("اكتب كلمة المرور", "Enter a password"),
      "auth/wrong-password": L("البريد أو كلمة المرور غير صحيحة", "Wrong email or password"),
      "auth/invalid-credential": L("البريد أو كلمة المرور غير صحيحة", "Wrong email or password"),
      "auth/invalid-login-credentials": L("البريد أو كلمة المرور غير صحيحة", "Wrong email or password"),
      "auth/user-not-found": L("البريد أو كلمة المرور غير صحيحة", "Wrong email or password"),
      "auth/too-many-requests": L("محاولاتٌ كثيرة — انتظر قليلاً", "Too many attempts — wait a little"),
      "auth/network-request-failed": L("تحقّق من الاتّصال بالإنترنت", "Check your connection"),
      "auth/operation-not-allowed": L("الدخول بالبريد غير مفعّلٍ بعد في الخادم", "Email sign-in isn't enabled on the server yet"),
      "sawa/already-linked": L("حسابك مربوطٌ سلفاً", "Already linked"),
      "sawa/no-server": L("جارٍ الاتّصال بالخادم… حاول بعد لحظة", "Connecting… try again in a moment")
    };
    return map[c] || ((e && e.message) || String(e));
  }
  // يبني نموذج البريد داخل حاوية؛ onDone يُستدعى بعد النجاح
  function emailForm(host, onDone) {
    var mode = "create";
    var tabs = mk("div", "display:flex;background:#eef2f6;border-radius:12px;padding:3px;margin:6px 0 10px");
    function tab(m, t) { var b = mk("button", "flex:1;border:0;border-radius:10px;padding:9px;font:800 13px system-ui;cursor:pointer", t); b.onclick = function () { mode = m; paint(); }; tabs.appendChild(b); return b; }
    var tCreate = tab("create", L("حساب جديد", "New account")), tSign = tab("signin", L("لديّ حساب", "I have an account"));
    host.appendChild(tabs);
    function field(ph, type) { var i = mk("input", "width:100%;box-sizing:border-box;border:1.5px solid #dfe5ec;color:#1A1A2E;background:#fff;border-radius:12px;padding:12px;font:600 15px system-ui;direction:ltr;text-align:left;margin:4px 0;outline:none"); i.placeholder = ph; i.type = type; return i; }
    var em = field("name@example.com", "email"); em.autocomplete = "email"; host.appendChild(em);
    var pwWrap = mk("div", "position:relative");
    var pw = field(L("كلمة المرور", "Password"), "password"); pwWrap.appendChild(pw);
    var eye = mk("button", "position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;font-size:18px;cursor:pointer", "👁"); eye.type = "button";
    eye.onclick = function () { pw.type = pw.type === "password" ? "text" : "password"; };
    pwWrap.appendChild(eye); host.appendChild(pwWrap);
    var msg = mk("div", "font:600 12.5px/1.6 system-ui;min-height:18px;margin:4px 2px;color:#b42318"); host.appendChild(msg);
    var go = mkBtn("", "primary"); host.appendChild(go);
    var forgot = mkBtn(L("نسيتُ كلمة المرور", "Forgot password"), "ghost"); forgot.style.marginTop = "4px"; host.appendChild(forgot);
    function paint() {
      tCreate.style.background = mode === "create" ? "#fff" : "transparent"; tSign.style.background = mode === "signin" ? "#fff" : "transparent";
      tCreate.style.color = mode === "create" ? "#1A1A2E" : "#6b7a89"; tSign.style.color = mode === "signin" ? "#1A1A2E" : "#6b7a89";
      go.textContent = mode === "create" ? L("إنشاء الحساب", "Create account") : L("دخول", "Sign in");
      pw.autocomplete = mode === "create" ? "new-password" : "current-password";
      pw.placeholder = mode === "create" ? L("كلمة مرور (٦ أحرف على الأقلّ)", "Password (6+ characters)") : L("كلمة المرور", "Password");
      forgot.style.display = mode === "signin" ? "" : "none"; msg.textContent = "";
    }
    go.onclick = function () {
      var e = em.value.trim(), p = pw.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { msg.textContent = L("البريد غير صحيح", "Invalid email"); return; }
      if (p.length < 6) { msg.textContent = L("كلمة المرور قصيرة — ٦ أحرف على الأقلّ", "Password too short — at least 6 characters"); return; }
      if (!S() || !S().linkEmail) { msg.textContent = emailErr({ code: "sawa/no-server" }); return; }
      go.disabled = true; go.textContent = "…"; msg.textContent = "";
      S().linkEmail(e, p, mode).then(function () { if (mode === "create") sendVerify(true); onDone && onDone(); }).catch(function (x) {
        msg.textContent = emailErr(x);
        if (x && (x.code === "auth/email-already-in-use" || x.code === "auth/credential-already-in-use")) { mode = "signin"; paint(); msg.textContent = emailErr(x); }
      }).then(function () { go.disabled = false; go.textContent = mode === "create" ? L("إنشاء الحساب", "Create account") : L("دخول", "Sign in"); });
    };
    forgot.onclick = function () {
      var e = em.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { msg.textContent = L("اكتب بريدك أوّلاً", "Enter your email first"); return; }
      S().resetPassword(e).then(function () { msg.style.color = "#2e7d5b"; msg.textContent = L("أرسلنا إلى بريدك رابطاً لتعيين كلمة مرورٍ جديدة (تفقّد مجلّد الرسائل غير المرغوبة).", "We emailed you a reset link (check spam)."); },
        function (x) { msg.style.color = "#b42318"; msg.textContent = emailErr(x); });
    };
    paint();
    return { go: go, focus: function () { try { em.focus(); } catch (e) {} } };
  }
  // C59: الضيف لم يكن يجد الربط بـGoogle إلا في «السحابة والمشاركة» — ورقةٌ واحدة بالخيارين
  function linkSheet() {
    var a = S() && S().authInfo ? S().authInfo() : null;
    if (a && !a.anon && a.uid) { toast(L("حسابك مربوطٌ سلفاً", "Already linked") + (a.email ? " — " + a.email : "")); return false; }
    var s = sheet(L("اربط حسابك", "Link your account"));
    s.box.appendChild(note(L("حسابك الآن «ضيف» على هذا الهاتف فقط. اربطه بـGoogle أو بالبريد لتدخل به من أيّ جهاز ولا تضيع محادثاتك ورمزك إن غيّرت هاتفك.",
      "Your account is a guest on this phone only. Link it to Google or email to sign in from any device and keep your chats and code."), "#9a6700", "#fdf3d8"));
    var gh = mk("div", "display:flex;justify-content:center;min-height:44px;margin:12px 0 8px");
    var g = mkBtn(L("المتابعة بحساب Google", "Continue with Google"), "primary");
    s.box.appendChild(gh); s.box.appendChild(g);
    g.onclick = function () { if (!S() || !S().linkGoogle) { toast(L("جارٍ تحميل التطبيق… حاول بعد لحظة", "Still loading… try again")); return; } s.close(); try { Promise.resolve(S().linkGoogle()).catch(function () {}); } catch (e) {} };
    if (S() && S().renderGoogleButton) S().renderGoogleButton(gh).then(function (ok) { if (ok) g.style.display = "none"; }, function () { gh.style.display = "none"; }); else gh.style.display = "none";
    var em = mkBtn(L("بالبريد الإلكتروني", "With email")); em.style.marginTop = "8px"; em.onclick = function () { s.close(); emailSheet(); }; s.box.appendChild(em);
    var c = mkBtn(L("لاحقاً", "Later"), "ghost"); c.style.marginTop = "6px"; c.onclick = s.close; s.box.appendChild(c);
    // بعد نجاح الربط تُغلق الورقة وحدها
    var t = setInterval(function () { var x = authNow(); if (!document.body.contains(s.ov)) { clearInterval(t); return; } if (x && !x.anon && x.uid) { clearInterval(t); s.close(); refresh(); } }, 700);
    return true;
  }
  function emailSheet() {
    var a = S() && S().authInfo ? S().authInfo() : null;
    if (a && !a.anon) { toast(L("حسابك مربوطٌ سلفاً", "Already linked") + (a.email ? " — " + a.email : "")); return false; }
    var s = sheet(L("الدخول بالبريد الإلكتروني", "Continue with email"));
    s.box.appendChild(note(L("حسابٌ بالبريد يحفظ محادثاتك وجهات اتّصالك، وتدخل به من أيّ جهاز.", "An email account keeps your chats and contacts on any device.")));
    var f = emailForm(s.box, function () { s.close(); refresh(); });
    setTimeout(f.focus, 80);
    return true;
  }

  // ---------- الإبلاغ عن محادثةٍ أو شخص (سياسة Google Play للمحتوى) ----------
  //  opts: { cid, target, name, kind: "dm"|"group", onBlock(), onDone() }
  function reportSheet(opts) {
    opts = opts || {};
    if (!state.uid) { toast(L("جارٍ الاتّصال بالخادم…", "Connecting…")); return false; }
    var s = sheet(opts.kind === "group" ? L("الإبلاغ عن المجموعة", "Report group") : L("الإبلاغ عن ", "Report ") + (opts.name || L("هذه المحادثة", "this chat")));
    var reasons = [["spam", L("رسائل مزعجة أو إعلانات", "Spam")], ["harassment", L("مضايقة أو تهديد", "Harassment or threats")], ["hate", L("كراهية أو إساءة", "Hate or abuse")],
      ["scam", L("احتيال أو طلب مال", "Scam or fraud")], ["sexual", L("محتوى جنسيّ أو غير لائق", "Sexual or inappropriate content")], ["violence", L("عنف", "Violence")],
      ["impersonation", L("انتحال شخصيّة", "Impersonation")], ["other", L("سببٌ آخر", "Something else")]];
    var pick = null, list = mk("div", "margin:6px 0");
    reasons.forEach(function (r) {
      var row = mk("label", "display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid #eef1f4;font:600 14px system-ui;cursor:pointer");
      var rb = mk("input"); rb.type = "radio"; rb.name = "sawa-rep"; rb.style.cssText = "width:18px;height:18px";
      rb.onchange = function () { pick = r[0]; go.disabled = false; go.style.opacity = "1"; };
      row.appendChild(rb); row.appendChild(mk("span", "", r[1])); list.appendChild(row);
    });
    s.box.appendChild(list);
    var ta = mk("textarea", "width:100%;box-sizing:border-box;border:1px solid #dfe5ec;color:#1A1A2E;background:#fff;border-radius:12px;padding:10px;font:500 14px/1.6 system-ui;min-height:60px;margin-top:6px");
    ta.maxLength = 500; ta.placeholder = L("تفاصيل إضافيّة (اختياريّ)", "More details (optional)"); s.box.appendChild(ta);
    var blk = null;
    if (opts.onBlock && opts.kind !== "group") {
      var bl = mk("label", "display:flex;align-items:center;gap:10px;font:700 14px system-ui;margin-top:10px;cursor:pointer");
      blk = mk("input"); blk.type = "checkbox"; blk.checked = true; blk.style.cssText = "width:18px;height:18px";
      bl.appendChild(blk); bl.appendChild(mk("span", "", L("احظره أيضاً", "Also block"))); s.box.appendChild(bl);
    }
    s.box.appendChild(note(L("يصل البلاغ إلى فريق سوا مع آخر ٢٠ رسالة من هذه المحادثة لمراجعتها. لا يُبلَّغ الطرف الآخر.", "Your report and the last 20 messages of this chat are sent to the Sawa team for review. The other person isn't notified.")));
    var go = mkBtn(L("إرسال البلاغ", "Send report"), "danger"); go.disabled = true; go.style.opacity = ".5"; go.style.marginTop = "8px";
    s.box.appendChild(go);
    go.onclick = function () {
      if (!pick) return;
      go.disabled = true; go.textContent = "…";
      var rp = { cid: opts.cid || null, target: opts.target || null, reason: pick, note: ta.value };
      if (opts.cid && e2eOn(chats[opts.cid])) { try { rp.e2eSample = e2eSampleOf(opts.cid); } catch (e) {} }   // C23: السرّيّة لا يقرؤها الخادم — نرفق ما على جهازك
      call("report.create", rp).then(function () {
        if (blk && blk.checked && opts.onBlock) { try { opts.onBlock(); } catch (e) {} }
        toast(L("وصلنا بلاغك ✓ — سنراجعه، وشكراً لك", "Report received ✓ — thank you"));
        try { if (opts.onDone) opts.onDone(); } catch (e) {}
        s.close();
      }).catch(function (e) { go.disabled = false; go.textContent = L("إرسال البلاغ", "Send report"); toast(L("تعذّر الإرسال: ", "Couldn't send: ") + codeErr(e)); });
    };
    return true;
  }

  // ---------- حذف الحساب (شرط Google Play) ----------
  function wipeLocal() {
    var done = function () {
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
      try { if (global.indexedDB) indexedDB.deleteDatabase("firebaseLocalStorageDb"); } catch (e) {}
      try { if (global.indexedDB) indexedDB.deleteDatabase("sawa-media"); } catch (e) {}   // C14: الصور والصوتيّات المنزّلة أيضاً (كما تعد نافذة الحذف)
      try { if (global.indexedDB) indexedDB.deleteDatabase("sawa-e2e"); } catch (e) {}   // C23: مفاتيح المحادثات السرّيّة
      // C58: ذاكرة Firestore المحلّيّة (C53) وأيّ مخزنٍ آخر — حتى لا تبقى محادثات الحساب السابق على الجهاز
      try { if (global.indexedDB && indexedDB.databases) indexedDB.databases().then(function (l) { (l || []).forEach(function (d) { if (d && d.name) try { indexedDB.deleteDatabase(d.name); } catch (e) {} }); }).catch(function () {}); } catch (e) {}
      try { if (global.indexedDB) indexedDB.deleteDatabase("firestore/[DEFAULT]/sawa-test-9770f/main"); } catch (e) {}
      setTimeout(function () { try { global.location.replace(global.location.pathname); } catch (e) {} }, 900);
    };
    try { firebase.auth().signOut().then(done, done); } catch (e) { done(); }
  }
  // C20: تسجيل الخروج حقّاً — كان «تسجيل الخروج» يقفل الشاشة برمزٍ لم يُضبط أصلاً ويبقى الحساب مفتوحاً
  function signOutSheet() {
    var a = authNow() || {}, me = state.me || {};
    var s = sheet(L("تسجيل الخروج", "Sign out"));
    s.box.appendChild(note((me.name || L("حسابك", "Your account")) + (a.email ? " · " + a.email : "") + (myCode() ? " · " + fmtCode(myCode()) : ""), "#1A1A2E", "#f3f7fb"));
    if (a.anon || !a.uid) {
      s.box.appendChild(note(L("حسابك «ضيف» غير مربوط بـGoogle أو بالبريد — إن خرجت فلن تستطيع العودة إليه أبداً، وتضيع محادثاتك ورمزك.",
        "Your guest account isn't linked to Google or email — signing out loses it forever."), "#b42318", "#fdecec"));
      var lk = mkBtn(L("اربط حسابك أوّلاً", "Link your account first"), "primary");
      lk.onclick = function () { s.close(); linkSheet(); };
      s.box.appendChild(lk);
      // C58: كان الضيف بلا سبيلٍ للخروج إلا الربط — الآن خيارٌ صريح بتأكيدٍ ثانٍ (مثلاً للدخول بحسابٍ آخر على هذا الجهاز)
      var out = mkBtn(L("الخروج وترك هذا الحساب", "Sign out and leave this account"), "danger"); out.style.marginTop = "8px";
      out.onclick = function () {
        out.style.display = "none"; lk.style.display = "none";
        s.box.insertBefore(note(L("تأكيد أخير: ستُمسح محادثاتك ورمزك وجهات اتّصالك من هذا الجهاز، ولا تُستعاد. ما وصل الآخرين يبقى عندهم.",
          "Last confirmation: your chats, code and contacts are erased from this device and cannot be recovered. What others received stays with them."), "#b42318", "#fdecec"), c0);
        var yes = mkBtn(L("نعم — اخرج ولا تحتفظ بشيء", "Yes — sign out and keep nothing"), "danger"); yes.style.marginTop = "6px";
        yes.onclick = function () {
          yes.disabled = true; yes.textContent = "…";
          var stop = function () { try { stopMyPresence(); } catch (e) {} wipeLocal(); };
          Promise.race([disablePush().catch(function () {}), new Promise(function (r) { setTimeout(r, 4000); })]).then(stop, stop);
        };
        s.box.insertBefore(yes, c0);
      };
      s.box.appendChild(out);
      var c0 = mkBtn(L("إلغاء", "Cancel")); c0.style.marginTop = "8px"; c0.onclick = function () { s.close(); }; s.box.appendChild(c0);
      return true;
    }
    s.box.appendChild(note(L("تخرج من هذا الجهاز فقط: تتوقّف إشعاراته، وتُمسح منه المحادثات المخزّنة والإعدادات. حسابك ورسائلك باقية، وتعود إليها بالدخول من جديد.",
      "Signs out this device only: notifications stop and local data is cleared. Your account and messages stay."), "#5b6b7c", "#f5f8fb"));
    s.box.appendChild(note(L("شجرة العائلة المحفوظة على هذا الجهاز وحده تُمسح أيضاً — إن لم ترفعها إلى السحابة فصدّرها أوّلاً من «حسابي».",
      "A family tree kept only on this device is cleared too — export or upload it first."), "#9a6700", "#fdf3d8"));
    if (Object.keys(chats).some(function (k) { return e2eOn(chats[k]); })) s.box.appendChild(note(L("🔒 مفاتيح محادثاتك السرّيّة تُمسح من هذا الجهاز — لن تُقرأ رسائلها السابقة بعد الخروج.",
      "🔒 Your secret-chat keys are erased from this device — their earlier messages can't be read after signing out."), "#b42318", "#fdecec"));
    var ok = mkBtn(L("تسجيل الخروج", "Sign out"), "danger"); ok.style.marginTop = "6px";
    ok.onclick = function () {
      ok.disabled = true; ok.textContent = "…";
      var stop = function () { try { stopMyPresence(); } catch (e) {} wipeLocal(); };
      Promise.race([disablePush().catch(function () {}), new Promise(function (r) { setTimeout(r, 4000); })]).then(stop, stop);
    };
    var no = mkBtn(L("إلغاء", "Cancel")); no.style.marginTop = "8px"; no.onclick = function () { s.close(); };
    s.box.appendChild(ok); s.box.appendChild(no);
    return true;
  }
  function deleteAccountSheet() {
    if (!state.uid) { toast(L("جارٍ الاتّصال بالخادم…", "Connecting…")); return false; }
    var s = sheet(L("حذف الحساب نهائيّاً", "Delete account permanently"));
    var a = authNow(), me = state.me || {};
    s.box.appendChild(note((me.name || L("حسابك", "Your account")) + (a && a.email ? " · " + a.email : "") + (myCode() ? " · " + fmtCode(myCode()) : ""), "#1A1A2E", "#f3f7fb"));
    var ul = mk("ul", "font:500 13.5px/1.9 system-ui;color:#3b4652;padding-inline-start:20px;margin:8px 0");
    [L("يُحذف: اسمك ورقمك ورمزك في سوا، وجهات اتّصالك وطلبات التواصل، ورسائلك المحفوظة، وإعداداتك، وأجهزتك المسجّلة للإشعارات.", "Deleted: your name, number and code, contacts and requests, saved messages, settings and notification devices."),
     L("تخرج من كلّ المحادثات والمجموعات. رسائلك عند الآخرين تبقى عندهم باسم «حساب محذوف».", "You leave all chats and groups. Messages others received stay with them under «Deleted account»."),
     L("العائلات التي تملكها: تنتقل ملكيّتها لأقدم محرّرٍ فيها، وتُحذف كاملةً إن كنت وحدك فيها (خلال دقائق).", "Families you own pass to their senior editor, or are fully deleted if you're the only member (within minutes)."),
     L("تُمسح بيانات سوا من هذا الجهاز أيضاً. لا يمكن التراجع.", "Sawa data on this device is wiped too. This can't be undone.")
    ].forEach(function (t) { ul.appendChild(mk("li", "", t)); });
    s.box.appendChild(ul);
    s.box.appendChild(mk("div", "font:700 13px system-ui;color:#5b6b7c;margin:6px 2px", L("للتأكيد اكتب: حذف", "To confirm, type: DELETE")));
    var inp = mk("input", "width:100%;box-sizing:border-box;border:1.5px solid #dfe5ec;color:#1A1A2E;background:#fff;border-radius:12px;padding:12px;font:700 16px system-ui;text-align:center;outline:none");
    inp.autocomplete = "off"; s.box.appendChild(inp);
    var go = mkBtn(L("حذف حسابي نهائيّاً", "Delete my account"), "danger"); go.style.marginTop = "10px"; go.disabled = true; go.style.opacity = ".5";
    var cancel = mkBtn(L("إلغاء", "Cancel")); cancel.style.marginTop = "8px";
    s.box.appendChild(go); s.box.appendChild(cancel);
    var ok = function () { var v = inp.value.trim(); return v === "حذف" || v.toUpperCase() === "DELETE"; };
    inp.oninput = function () { go.disabled = !ok(); go.style.opacity = ok() ? "1" : ".5"; };
    cancel.onclick = s.close;
    go.onclick = function () {
      if (!ok()) return;
      go.disabled = true; cancel.disabled = true; go.textContent = L("جارٍ الحذف…", "Deleting…");
      call("account.delete", { confirm: "DELETE" }).then(function () {
        s.box.innerHTML = "";
        s.box.appendChild(mk("div", "font:800 17px system-ui;text-align:center;margin:18px 0 6px", L("حُذف حسابك ✓", "Your account was deleted ✓")));
        s.box.appendChild(note(L("شكراً لاستعمالك سوا. يُعاد تشغيل التطبيق الآن.", "Thanks for using Sawa. Restarting…")));
        wipeLocal();
      }).catch(function (e) {
        go.disabled = false; cancel.disabled = false; go.textContent = L("حذف حسابي نهائيّاً", "Delete my account");
        toast(L("تعذّر الحذف: ", "Couldn't delete: ") + codeErr(e));
      });
    };
    return true;
  }

  // ---------- شاشات البداية (المستخدم الجديد) ----------
  //  ترحيب ← الدخول (Google · البريد · بدون حساب) ← الاسم ← رمزك ← الإشعارات ← تواصل مع أحد ← المحادثات
  var onb = null, pendingCode = null, pendingDelete = false, onbDeleteMode = false;
  var ONB_BASE = ["login", "name", "code", "notify", "find"];
  function onbSteps() { return installable() ? ["login", "name", "code", "notify", "install", "find"] : ONB_BASE; }
  function onbActive() { return !!onb; }
  function onbNeeded() {
    if (lsGet("sawa_onboarded", 0)) return false;
    if (lsGet("sawa_onb_step", null)) return true;   // بدأها ولم يكملها (أو عاد من صفحة Google)
    if (lsGet("sawa_people_cache", null)) { lsSet("sawa_onboarded", Date.now()); return false; }   // جهازٌ مستعمَلٌ قبل هذه النسخة
    try { var q = new URLSearchParams(global.location.search); if (q.get("room") || q.get("call") || q.get("join")) return false; } catch (e) {}
    return true;
  }
  function authNow() { try { return S() && S().authInfo ? S().authInfo() : null; } catch (e) { return null; } }
  // c21: تصميمٌ حديث — خلفيّة متدرّجة بأضواءٍ ناعمة، أيقونات زجاجيّة، شريط تقدّم مع رجوع، حركةٌ هادئة (تُلغى مع «تقليل الحركة»)
  var ONB_ICON = {
    lock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1.1"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
    bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.1.7 3.5 2.8 3.5 5.7"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.8A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    room: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10.5" r="2"/><circle cx="15" cy="10.5" r="2"/><path d="M5.8 17c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3 2.3c.4-1.5 1.6-2.3 3-2.3s2.6.8 3.2 2.3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="m9 6 6 6-6 6"/>',
    chev: '<path d="m15 6-6 6 6 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5H7z"/>',
    devices: '<rect x="2" y="5" width="13" height="10" rx="2"/><path d="M5 19h7"/><rect x="17" y="8" width="5" height="11" rx="1.5"/>',
    share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    plus: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
    menu: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>'
  };
  var ONB_G = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  var ONB_CSS = [
    "#sawa-onb{position:fixed;inset:0;z-index:2147483000;color:#fff;display:flex;flex-direction:column;font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;overflow-y:auto;overflow-x:hidden;background:#0f3561;-webkit-tap-highlight-color:transparent}",
    "#sawa-onb *{box-sizing:border-box}",
    "#sawa-onb .ob-bg{position:fixed;inset:0;pointer-events:none;overflow:hidden;background:radial-gradient(130% 75% at 50% -12%,#4aa3ea 0%,#2a78c0 32%,#185392 62%,#0d3260 100%)}",
    "#sawa-onb .ob-bg::after{content:'';position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.10) 1px,transparent 1.2px);background-size:22px 22px;-webkit-mask-image:linear-gradient(to bottom,#000,transparent 55%);mask-image:linear-gradient(to bottom,#000,transparent 55%)}",
    "#sawa-onb .ob-blob{position:absolute;border-radius:50%;filter:blur(46px);opacity:.5;animation:ob-float 16s ease-in-out infinite}",
    "#sawa-onb .ob-b1{width:300px;height:300px;background:#6cc0ff;top:-90px;inset-inline-start:-110px}",
    "#sawa-onb .ob-b2{width:280px;height:280px;background:#6d72ff;bottom:6%;inset-inline-end:-130px;opacity:.38;animation-delay:-5s}",
    "#sawa-onb .ob-b3{width:220px;height:220px;background:#22c7b4;bottom:-110px;inset-inline-start:12%;opacity:.3;animation-delay:-10s}",
    "#sawa-onb .ob-top,#sawa-onb .ob-body,#sawa-onb .ob-foot{position:relative;z-index:1;width:100%;max-width:460px;margin:0 auto}",
    "#sawa-onb .ob-top{display:flex;align-items:center;gap:12px;padding:calc(env(safe-area-inset-top,0px) + 14px) 18px 0;min-height:56px}",
    "#sawa-onb .ob-bar{flex:1;display:flex;gap:5px}",
    "#sawa-onb .ob-seg{flex:1;height:4px;border-radius:4px;background:rgba(255,255,255,.22);overflow:hidden}",
    "#sawa-onb .ob-seg i{display:block;height:100%;width:0;background:#fff;border-radius:4px}",
    "#sawa-onb .ob-seg.done i{width:100%}",
    "#sawa-onb .ob-seg.cur i{width:100%;animation:ob-fill .6s cubic-bezier(.2,.8,.2,1) both}",
    "#sawa-onb .ob-count{font:700 12px system-ui;color:rgba(255,255,255,.75);min-width:34px;text-align:end}",
    "#sawa-onb .ob-back{width:40px;height:40px;flex:none;border-radius:14px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:#fff;display:grid;place-items:center;cursor:pointer;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}",
    "#sawa-onb .ob-back.ob-hide{visibility:hidden}",
    "#sawa-onb[dir=ltr] .ob-back svg,#sawa-onb[dir=rtl] .ob-fwd svg{transform:scaleX(-1)}",
    "#sawa-onb .ob-body{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:14px 24px 8px}",
    "#sawa-onb .ob-foot{padding:10px 20px calc(env(safe-area-inset-bottom,0px) + 22px);display:flex;flex-direction:column;gap:10px}",
    "#sawa-onb .ob-body>*,#sawa-onb .ob-foot>*{animation:ob-in .55s cubic-bezier(.2,.8,.2,1) both}",
    "#sawa-onb .ob-body>:nth-child(2){animation-delay:.06s}#sawa-onb .ob-body>:nth-child(3){animation-delay:.12s}#sawa-onb .ob-body>:nth-child(4){animation-delay:.18s}#sawa-onb .ob-body>:nth-child(n+5){animation-delay:.24s}",
    "#sawa-onb .ob-foot>*{animation-delay:.2s}#sawa-onb .ob-foot>:nth-child(2){animation-delay:.26s}#sawa-onb .ob-foot>:nth-child(n+3){animation-delay:.32s}",
    "#sawa-onb .ob-tile{position:relative;width:92px;height:92px;border-radius:30px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(255,255,255,.3),rgba(255,255,255,.07));border:1px solid rgba(255,255,255,.38);box-shadow:0 22px 44px -14px rgba(3,20,45,.6),inset 0 1px 0 rgba(255,255,255,.45);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}",
    "#sawa-onb .ob-tile::before{content:'';position:absolute;inset:-12px;border-radius:40px;border:1px solid rgba(255,255,255,.16);animation:ob-ring 3.2s ease-out infinite}",
    "#sawa-onb .ob-tile svg{width:44px;height:44px}",
    "#sawa-onb .ob-ring svg{animation:ob-ring-bell 2.6s ease-in-out 1s infinite;transform-origin:50% 15%}",
    "#sawa-onb .ob-h{font:800 26px/1.35 system-ui;margin:24px 0 8px;letter-spacing:-.2px;text-wrap:balance}",
    "#sawa-onb .ob-p{font:500 15px/1.85 system-ui;color:rgba(255,255,255,.8);max-width:340px;text-wrap:pretty}",
    "#sawa-onb .ob-grad{background:linear-gradient(90deg,#fff,#a8dbff);-webkit-background-clip:text;background-clip:text;color:transparent}",
    "#sawa-onb .ob-logo{width:108px;height:108px;border-radius:32px;box-shadow:0 0 0 8px rgba(255,255,255,.08),0 0 0 18px rgba(255,255,255,.04),0 26px 50px -12px rgba(3,20,45,.7);animation:ob-bob 6s ease-in-out infinite}",
    "#sawa-onb .ob-feats{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;margin-top:26px}",
    "#sawa-onb .ob-feat{display:flex;align-items:center;gap:10px;padding:12px;border-radius:18px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);text-align:start;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}",
    "#sawa-onb .ob-feat b{display:block;font:800 13.5px/1.3 system-ui}",
    "#sawa-onb .ob-feat small{display:block;font:500 11.5px/1.5 system-ui;color:rgba(255,255,255,.7);margin-top:2px}",
    "#sawa-onb .ob-fi{width:36px;height:36px;flex:none;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,.16)}",
    "#sawa-onb .ob-fi svg{width:19px;height:19px}",
    "#sawa-onb .ob-btn{width:100%;border:0;border-radius:16px;padding:15px 16px;font:800 16px system-ui;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;transition:transform .15s,box-shadow .2s,background .2s;-webkit-user-select:none;user-select:none}",
    "#sawa-onb .ob-btn:active{transform:scale(.975)}",
    "#sawa-onb .ob-btn:disabled{opacity:.7;cursor:default}",
    "#sawa-onb .ob-btn:focus-visible,#sawa-onb .ob-back:focus-visible,#sawa-onb .ob-opt:focus-visible{outline:3px solid rgba(255,255,255,.75);outline-offset:2px}",
    "#sawa-onb .ob-btn svg{width:20px;height:20px;flex:none}",
    "#sawa-onb .ob-primary{background:#fff;color:#14508c;box-shadow:0 14px 28px -10px rgba(3,20,45,.6)}",
    "#sawa-onb .ob-glass{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.28);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}",
    "#sawa-onb .ob-link{background:transparent;color:rgba(255,255,255,.85);font-weight:700;font-size:15px;padding:10px}",
    "#sawa-onb .ob-or{display:flex;align-items:center;gap:12px;font:600 12px system-ui;color:rgba(255,255,255,.6)}",
    "#sawa-onb .ob-or::before,#sawa-onb .ob-or::after{content:'';flex:1;height:1px;background:rgba(255,255,255,.2)}",
    "#sawa-onb .ob-perks{display:flex;flex-direction:column;gap:8px;width:100%;max-width:330px;margin-top:22px}",
    "#sawa-onb .ob-perk{display:flex;align-items:center;gap:10px;font:600 14px/1.5 system-ui;color:rgba(255,255,255,.9);text-align:start}",
    "#sawa-onb .ob-perk span{width:28px;height:28px;flex:none;border-radius:10px;display:grid;place-items:center;background:rgba(255,255,255,.14)}",
    "#sawa-onb .ob-perk svg{width:16px;height:16px}",
    "#sawa-onb .ob-legal{font:500 12px/1.8 system-ui;color:rgba(255,255,255,.7);text-align:center;margin-top:2px}",
    "#sawa-onb .ob-legal a{color:#fff;font-weight:700;text-decoration:underline;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.4)}",
    "#sawa-onb .ob-card{background:#fff;color:#1A1A2E;border-radius:26px;padding:20px 18px 14px;width:100%;text-align:start;box-shadow:0 30px 60px -20px rgba(3,20,45,.7)}",
    "#sawa-onb .ob-card-h{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:6px;text-align:center}",
    "#sawa-onb .ob-card-h span{width:52px;height:52px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(145deg,#3d93dc,#1d5f9e);color:#fff;box-shadow:0 10px 20px -8px rgba(29,95,158,.7)}",
    "#sawa-onb .ob-card-h svg{width:26px;height:26px}",
    "#sawa-onb .ob-card-h b{font:800 19px system-ui}",
    "#sawa-onb .ob-card-h small{font:500 13px/1.6 system-ui;color:#5b6b7b}",
    "#sawa-onb .ob-card input:focus{border-color:#2F80C8!important;box-shadow:0 0 0 4px rgba(47,128,200,.15)}",
    "#sawa-onb .ob-av{width:104px;height:104px;border-radius:50%;display:grid;place-items:center;font:800 38px system-ui;background:linear-gradient(145deg,#6cc0ff,#2F80C8 55%,#1d5f9e);border:3px solid rgba(255,255,255,.85);box-shadow:0 0 0 8px rgba(255,255,255,.08),0 24px 44px -14px rgba(3,20,45,.7);transition:transform .25s}",
    "#sawa-onb .ob-av svg{width:48px;height:48px}",
    "#sawa-onb .ob-av.pop{transform:scale(1.06)}",
    "#sawa-onb .ob-input{width:100%;margin-top:24px;border:2px solid transparent;border-radius:18px;padding:16px;font:700 19px system-ui;text-align:center;outline:none;color:#1A1A2E;background:#fff;caret-color:#2F80C8;box-shadow:0 14px 30px -14px rgba(3,20,45,.6);transition:border-color .2s,box-shadow .2s}",
    "#sawa-onb .ob-input:focus{border-color:#9fd2ff;box-shadow:0 0 0 5px rgba(255,255,255,.18),0 14px 30px -14px rgba(3,20,45,.6)}",
    "#sawa-onb .ob-input::placeholder{color:#9aa7b4;font-weight:600}",
    "#sawa-onb .ob-err{font:700 13px system-ui;color:#ffd2d2;min-height:20px;margin-top:10px}",
    "#sawa-onb .ob-code{width:100%;margin:24px 0 16px;background:#fff;color:#14508c;border-radius:24px;padding:16px 12px 18px;box-shadow:0 26px 50px -18px rgba(3,20,45,.7)}",
    "#sawa-onb .ob-code small{display:block;font:800 11.5px system-ui;letter-spacing:.6px;color:#6b8db0;margin-bottom:6px}",
    "#sawa-onb .ob-code div{font:800 32px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:2px;word-spacing:6px;direction:ltr}",
    "#sawa-onb .ob-row{display:flex;gap:10px;width:100%;margin-top:18px}",
    "#sawa-onb .ob-row .ob-btn{font-size:15px;padding:13px}",
    "#sawa-onb .ob-notif{display:flex;align-items:center;gap:12px;width:100%;max-width:340px;margin-top:24px;padding:12px 14px;border-radius:20px;background:rgba(255,255,255,.94);color:#1A1A2E;text-align:start;box-shadow:0 20px 40px -16px rgba(3,20,45,.7)}",
    "#sawa-onb .ob-body>.ob-notif{animation:ob-drop .7s cubic-bezier(.2,.9,.25,1.2) .35s both}",
    "#sawa-onb .ob-notif img{width:38px;height:38px;border-radius:11px;flex:none}",
    "#sawa-onb .ob-notif b{display:flex;justify-content:space-between;font:800 13px system-ui}",
    "#sawa-onb .ob-notif b em{font:500 11.5px system-ui;color:#7b8794;font-style:normal}",
    "#sawa-onb .ob-notif span{display:block;font:500 13px/1.5 system-ui;color:#3c4a57;margin-top:2px}",
    "#sawa-onb .ob-opt{width:100%;display:flex;align-items:center;gap:12px;padding:14px;border-radius:18px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);color:#fff;text-align:start;cursor:pointer;transition:transform .15s,background .2s;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}",
    "#sawa-onb .ob-opt:active{transform:scale(.98);background:rgba(255,255,255,.18)}",
    "#sawa-onb .ob-opt .ob-fi{width:42px;height:42px;border-radius:14px;background:rgba(255,255,255,.18)}",
    "#sawa-onb .ob-opt .ob-fi svg{width:21px;height:21px}",
    "#sawa-onb .ob-opt b{display:block;font:800 15px system-ui}",
    "#sawa-onb .ob-opt small{display:block;font:500 12.5px/1.5 system-ui;color:rgba(255,255,255,.72);margin-top:2px}",
    "#sawa-onb .ob-opt .ob-txt{flex:1}",
    "#sawa-onb .ob-opt .ob-fwd svg{width:18px;height:18px;opacity:.7}",
    "#sawa-onb .ob-opts{display:flex;flex-direction:column;gap:10px;width:100%;margin-top:24px}",
    "#sawa-onb .ob-steps,.sawa-inst .ob-steps{display:flex;flex-direction:column;gap:10px;width:100%;max-width:360px;margin:20px auto 0;text-align:start}",
    "#sawa-onb .ob-step{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:16px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);animation:ob-in .5s both}",
    "#sawa-onb .ob-step:nth-child(2){animation-delay:.08s}#sawa-onb .ob-step:nth-child(3){animation-delay:.16s}",
    "#sawa-onb .ob-step .ob-num,.sawa-inst .ob-num{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:800 13px system-ui;background:#fff;color:#1d5fa0}",
    "#sawa-onb .ob-step .ob-fi{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,.16)}",
    "#sawa-onb .ob-step .ob-fi svg,.sawa-inst .ob-step .ob-fi svg{width:20px;height:20px}",
    "#sawa-onb .ob-step span:last-child{font:600 13.5px/1.5 system-ui}",
    "#sawa-onb .ob-home{display:flex;align-items:center;gap:14px;margin-top:22px;padding:12px 16px;border-radius:22px;background:rgba(255,255,255,.94);color:#1A1A2E;box-shadow:0 20px 40px -16px rgba(3,20,45,.7);animation:ob-drop .7s cubic-bezier(.2,.9,.25,1.2) .3s both}",
    "#sawa-onb .ob-home img{width:52px;height:52px;border-radius:14px;flex:none;box-shadow:0 4px 10px rgba(0,0,0,.18)}",
    "#sawa-onb .ob-home b{display:block;font:800 14px system-ui}#sawa-onb .ob-home small{display:block;font:500 12px system-ui;color:#5b6775;margin-top:2px}",
    ".sawa-inst .ob-step{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:16px;background:#f1f5f9;color:#1f2937;font:600 13.5px/1.5 system-ui}",
    ".sawa-inst .ob-step .ob-fi{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:#dbeafe;color:#1d5fa0}",
    "@keyframes ob-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}",
    "@keyframes ob-fill{from{width:0}to{width:100%}}",
    "@keyframes ob-float{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(24px,30px) scale(1.12)}}",
    "@keyframes ob-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}",
    "@keyframes ob-ring{0%{transform:scale(.92);opacity:.9}100%{transform:scale(1.18);opacity:0}}",
    "@keyframes ob-ring-bell{0%,60%,100%{transform:rotate(0)}65%{transform:rotate(14deg)}72%{transform:rotate(-12deg)}79%{transform:rotate(8deg)}86%{transform:rotate(-5deg)}}",
    "@keyframes ob-drop{from{opacity:0;transform:translateY(-22px) scale(.96)}to{opacity:1;transform:none}}",
    "@media (max-height:640px){#sawa-onb .ob-tile{width:76px;height:76px;border-radius:24px}#sawa-onb .ob-tile svg{width:36px;height:36px}#sawa-onb .ob-h{font-size:23px;margin-top:16px}#sawa-onb .ob-logo{width:88px;height:88px;border-radius:26px}#sawa-onb .ob-feats{margin-top:18px}}",
    "@media (prefers-reduced-motion:reduce){#sawa-onb *,#sawa-onb *::before{animation:none!important;transition:none!important}}"
  ].join("\n");
  function onbCss() {
    if (document.getElementById("sawa-onb-css")) return;
    var s = document.createElement("style"); s.id = "sawa-onb-css"; s.textContent = ONB_CSS;
    (document.head || document.body).appendChild(s);
  }
  function oi(name) { var s = mk("span"); s.style.display = "contents"; s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ONB_ICON[name] || "") + "</svg>"; return s; }
  function oc(tag, cls, text) { var e = mk(tag, "", text); e.className = cls; return e; }
  function arNum(n) { return isAr() ? String(n).replace(/\d/g, function (d) { return "٠١٢٣٤٥٦٧٨٩"[d]; }) : String(n); }
  function onbStart() {
    if (onb || !document.body) return;
    onbCss();
    var el = mk("div"); el.id = "sawa-onb"; el.dir = isAr() ? "rtl" : "ltr";
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", L("البدء في سوا", "Getting started with Sawa"));
    document.body.appendChild(el);
    onb = { el: el, step: null, timer: null };
    onbGo(lsGet("sawa_onb_step", "welcome"));
  }
  function onbBackOf(step) {
    if (step === "email") return "login";
    if (step === "name") { var a = authNow(); return a && !a.anon ? null : "login"; }
    if (step === "code") return "name";
    if (step === "notify") return "code";
    if (step === "install") return pushState() === "default" ? "notify" : "code";
    if (step === "find") return installable() ? "install" : pushState() === "default" ? "notify" : "code";
    return null;
  }
  function onbFrame(step) {
    var el = onb.el; el.innerHTML = "";
    if (onb.timer) { clearInterval(onb.timer); onb.timer = null; }
    var bg = oc("div", "ob-bg"); ["ob-b1", "ob-b2", "ob-b3"].forEach(function (c) { bg.appendChild(oc("div", "ob-blob " + c)); }); el.appendChild(bg);
    var ONB_STEPS = onbSteps(), i = ONB_STEPS.indexOf(step === "email" ? "login" : step);
    var top = oc("div", "ob-top");
    if (i >= 0) {
      var prev = onbBackOf(step);
      var bk = oc("button", "ob-back" + (prev ? "" : " ob-hide")); bk.type = "button"; bk.setAttribute("aria-label", L("رجوع", "Back")); bk.appendChild(oi("back"));
      if (prev) bk.onclick = function () { onbGo(prev); };
      var bar = oc("div", "ob-bar"); bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "1"); bar.setAttribute("aria-valuemax", String(ONB_STEPS.length)); bar.setAttribute("aria-valuenow", String(i + 1));
      ONB_STEPS.forEach(function (_, k) { var sg = oc("div", "ob-seg" + (k < i ? " done" : k === i ? " cur" : "")); sg.appendChild(mk("i")); bar.appendChild(sg); });
      top.appendChild(bk); top.appendChild(bar); top.appendChild(oc("div", "ob-count", arNum(i + 1) + "/" + arNum(ONB_STEPS.length)));
    }
    el.appendChild(top);
    var body = oc("div", "ob-body"), foot = oc("div", "ob-foot");
    el.appendChild(body); el.appendChild(foot);
    try { el.scrollTop = 0; } catch (e) {}
    return { body: body, foot: foot };
  }
  function bigBtn(text, kind, icon) {
    var b = oc("button", "ob-btn " + (kind === "white" ? "ob-primary" : kind === "link" ? "ob-link" : "ob-glass")); b.type = "button";
    if (icon) b.appendChild(oi(icon));
    b.appendChild(mk("span", "", text));
    return b;
  }
  function btnText(b, t) { var s = b.querySelector("span:last-child"); if (s && s.parentNode === b) s.textContent = t; else b.textContent = t; }
  function hTitle(t) { return oc("div", "ob-h", t); }
  function hSub(t) { return oc("div", "ob-p", t); }
  function oTile(icon, extra) { var t = oc("div", "ob-tile" + (extra ? " " + extra : "")); t.appendChild(oi(icon)); return t; }
  function oOpt(icon, title, sub) {
    var o = oc("button", "ob-opt"); o.type = "button";
    var fi = oc("span", "ob-fi"); fi.appendChild(oi(icon)); o.appendChild(fi);
    var tx = oc("span", "ob-txt"); tx.appendChild(mk("b", "", title)); tx.appendChild(mk("small", "", sub)); o.appendChild(tx);
    var fw = oc("span", "ob-fwd"); fw.appendChild(oi("chev")); o.appendChild(fw);
    return o;
  }
  function initials(nm) {
    var w = String(nm || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!w.length) return "";
    var a = Array.from(w[0])[0] || "", z = w.length > 1 ? (Array.from(w[w.length - 1])[0] || "") : "";
    return z ? a + (/[\u0600-\u06FF]/.test(a + z) ? "\u200C" : "") + z : a;   // حرفان عربيّان منفصلان لا متّصلان
  }
  function onbGo(step) {
    if (!onb) return;
    onb.step = step; lsSet("sawa_onb_step", step);
    var f = onbFrame(step), b = f.body, ft = f.foot;
    if (step === "welcome") {
      var logo = mk("img"); logo.className = "ob-logo"; logo.src = "./icons/icon-192.png"; logo.alt = "سوا";
      b.appendChild(logo);
      var h = hTitle(L("أهلاً بك في ", "Welcome to ")); h.appendChild(oc("span", "ob-grad", L("سوا", "Sawa"))); b.appendChild(h);
      b.appendChild(hSub(L("محادثاتك ومكالماتك وغرف اجتماعاتك — في تطبيقٍ واحدٍ بسيط.", "Your chats, calls and meeting rooms — in one simple app.")));
      var feats = oc("div", "ob-feats");
      [["chat", L("محادثات", "Chats"), L("نصّ وصوت وصور", "Text, voice, photos")],
       ["phone", L("مكالمات", "Calls"), L("صوت وفيديو", "Voice & video")],
       ["room", L("غرف", "Rooms"), L("اجتماعات فوريّة ومجدولة", "Live & scheduled")],
       ["hash", L("رمزٌ خاصّ", "Private code"), L("تواصل دون رقم هاتف", "No phone number needed")]].forEach(function (x) {
        var c = oc("div", "ob-feat"), fi = oc("span", "ob-fi"); fi.appendChild(oi(x[0])); c.appendChild(fi);
        var t = mk("div"); t.appendChild(mk("b", "", x[1])); t.appendChild(mk("small", "", x[2])); c.appendChild(t); feats.appendChild(c);
      });
      b.appendChild(feats);
      var st = bigBtn(L("ابدأ", "Get started"), "white"); st.appendChild(oc("span", "ob-fwd", "")).appendChild(oi("arrow"));
      st.onclick = function () { onbGo("login"); }; ft.appendChild(st);
      return;
    }
    if (step === "login") {
      var a = authNow();
      if (a && !a.anon) return onbDeleteMode ? onbDone() : onbGo("name");
      b.appendChild(oTile("lock"));
      b.appendChild(hTitle(L("أنشئ حسابك", "Create your account")));
      b.appendChild(hSub(L("حسابك يحفظ محادثاتك وجهات اتّصالك، وتدخل به من أيّ جهاز.", "Your account keeps your chats and contacts, on any device.")));
      if (onbDeleteMode) { b.appendChild(mk("div", "font:700 14px/1.8 system-ui;color:#ffe08a;margin-top:14px", L("لحذف حسابك: ادخل بالحساب نفسه الذي تريد حذفه.", "To delete your account, sign in with that account."))); }
      else {
        var perks = oc("div", "ob-perks");
        [["cloud", L("محادثاتك محفوظة ولا تضيع بتغيير الهاتف", "Your chats are kept, even if you change phones")],
         ["devices", L("ادخل من هاتفك أو حاسوبك", "Use it on your phone or computer")]].forEach(function (x) {
          var r = oc("div", "ob-perk"), ic = mk("span"); ic.appendChild(oi(x[0])); r.appendChild(ic); r.appendChild(mk("div", "", x[1])); perks.appendChild(r);
        });
        b.appendChild(perks);
      }
      var g = bigBtn(L("المتابعة بحساب Google", "Continue with Google"), "white");
      var gi = mk("span"); gi.style.cssText = "display:grid;place-items:center"; gi.innerHTML = ONB_G; g.insertBefore(gi, g.firstChild);
      // C54: زرّ Google الرسميّ (GIS) — يعمل داخل التطبيق المثبّت بلا إعادة توجيه؛ زرّنا القديم يبقى احتياطاً إن لم يُحمَّل
      var gh = oc("div", "ob-gsi"); gh.style.cssText = "display:flex;justify-content:center;min-height:44px;margin-bottom:10px";
      var em = bigBtn(L("المتابعة بالبريد الإلكتروني", "Continue with email"), null, "mail");
      var gu = bigBtn(L("جرّب بدون حساب", "Try without an account"), "link");
      ft.appendChild(gh); ft.appendChild(g); ft.appendChild(em);
      (function () {
        var tries = 0;
        (function tryGsi() {
          if (!onb || onb.step !== "login") return;
          if (S() && S().renderGoogleButton) {
            S().renderGoogleButton(gh).then(function (ok) { if (ok && onb && onb.step === "login") { g.style.display = "none"; } }, function () { gh.style.display = "none"; });
            return;
          }
          if (++tries < 40) setTimeout(tryGsi, 250); else gh.style.display = "none";
        })();
      })();
      if (!onbDeleteMode) { ft.appendChild(oc("div", "ob-or", L("أو", "or"))); ft.appendChild(gu); }
      var legal = oc("div", "ob-legal");
      legal.appendChild(document.createTextNode(L("بالمتابعة توافق على ", "By continuing you agree to the ")));
      var lt = mk("a", "", L("شروط الاستخدام", "Terms")); lt.href = "/terms"; lt.target = "_blank"; lt.rel = "noopener";
      var lp = mk("a", "", L("سياسة الخصوصيّة", "Privacy Policy")); lp.href = "/privacy"; lp.target = "_blank"; lp.rel = "noopener";
      legal.appendChild(lt); legal.appendChild(document.createTextNode(L(" و", " and "))); legal.appendChild(lp);
      ft.appendChild(legal);
      g.onclick = function () {
        // C52: لا ننتظر الهويّة المجهولة — sawa-sync يدخل بـGoogle مباشرةً إن لم تكن جاهزة
        if (!S() || !S().linkGoogle) { toast(L("جارٍ تحميل التطبيق… حاول بعد لحظة", "Still loading… try again in a moment")); return; }
        try { Promise.resolve(S().linkGoogle()).catch(function () {}); } catch (e) {}
      };
      em.onclick = function () { onbGo("email"); };
      gu.onclick = function () {
        var s = sheet(L("المتابعة بدون حساب؟", "Continue without an account?"));
        s.box.appendChild(note(L("حسابك سيكون محفوظاً في هذا الهاتف فقط: إن مسحتَ بيانات التطبيق أو غيّرت هاتفك تضيع محادثاتك وجهات اتّصالك. يمكنك ربطه بحسابٍ لاحقاً من «حسابي» ← «السحابة والمشاركة».",
          "Your account will live on this phone only: clearing app data or changing phones loses your chats and contacts. You can link an account later from «Me» → «Cloud & sharing»."), "#8a5a00", "#fff7e0"));
        var y = mkBtn(L("متابعة بدون حساب", "Continue without account")); var n = mkBtn(L("رجوع", "Back"), "primary");
        y.style.marginTop = "8px"; n.style.marginTop = "8px";
        y.onclick = function () { s.close(); onbGo("name"); }; n.onclick = s.close;
        s.box.appendChild(n); s.box.appendChild(y);
      };
      // ربط Google (نافذةً منبثقة أو إعادة توجيه): نلاحظ تغيّر الهويّة ونتقدّم
      onb.timer = setInterval(function () { var x = authNow(); if (x && !x.anon && onb && onb.step === "login") { if (onbDeleteMode) onbDone(); else onbGo("name"); } }, 700);
      return;
    }
    if (step === "email") {
      var card = oc("div", "ob-card");
      card.dir = isAr() ? "rtl" : "ltr";
      var ch = oc("div", "ob-card-h"), cic = mk("span"); cic.appendChild(oi("mail")); ch.appendChild(cic);
      ch.appendChild(mk("b", "", L("البريد الإلكتروني", "Email")));
      ch.appendChild(mk("small", "", L("أنشئ حساباً جديداً أو ادخل بحسابك الحاليّ.", "Create a new account or use your existing one.")));
      card.appendChild(ch);
      b.appendChild(card);
      var form = emailForm(card, function () { if (onbDeleteMode) onbDone(); else onbGo("name"); });
      if (form.go) { form.go.style.background = "linear-gradient(135deg,#3d93dc,#1d5f9e)"; form.go.style.padding = "14px"; form.go.style.borderRadius = "14px"; form.go.style.fontSize = "15px"; form.go.style.boxShadow = "0 10px 22px -10px rgba(29,95,158,.8)"; }
      setTimeout(form.focus, 80);
      return;
    }
    if (step === "name") {
      var av = oc("div", "ob-av"); b.appendChild(av);
      b.appendChild(hTitle(L("ما اسمك؟", "What's your name?")));
      b.appendChild(hSub(L("يظهر لمن تتواصل معهم.", "Shown to the people you talk to.")));
      var inp = oc("input", "ob-input");
      inp.placeholder = L("مثال: خالد علي", "e.g. Khalid Ali"); inp.maxLength = 40; inp.autocomplete = "name"; inp.enterKeyHint = "next";
      inp.setAttribute("aria-label", L("اسمك", "Your name"));
      var err = oc("div", "ob-err"); err.setAttribute("aria-live", "polite");
      b.appendChild(inp); b.appendChild(err);
      var lastIni = null;
      var paintAv = function () {
        var ini = initials(inp.value);
        if (ini === lastIni) return; lastIni = ini;
        av.innerHTML = ""; if (ini) av.textContent = ini; else av.appendChild(oi("user"));
        av.classList.add("pop"); setTimeout(function () { av.classList.remove("pop"); }, 180);
      };
      var fillName = function () { if (inp.value) return; var a2 = authNow(); inp.value = (state.me && state.me.name) || (state.me && state.me.googleName) || (a2 && a2.name) || ""; paintAv(); };
      paintAv(); fillName(); whenReady(function () { refresh().then(fillName); });
      inp.oninput = function () { err.textContent = ""; paintAv(); };
      var nx = bigBtn(L("التالي", "Next"), "white"); ft.appendChild(nx);
      nx.onclick = function () {
        var nm = inp.value.replace(/\s+/g, " ").trim();
        if (nm.length < 2) { err.textContent = L("اكتب اسماً من حرفين على الأقلّ", "At least 2 letters"); return; }
        nx.disabled = true; btnText(nx, "…");
        // C57: لا ننتظر الخادم — الاسم يُحفظ على الجهاز ويُرسل حين تجهز الهويّة (كان الزرّ يعلق على «…» إن تأخّر الدخول المجهول)
        if (!state.uid) {
          lsSet("sawa_pending_name", nm); lsSet("sawa_name_asked", Date.now());
          state.me = Object.assign({}, state.me || {}, { name: nm }); publish();
          err.style.color = "#cfe3ff"; err.textContent = L("سيُحفظ اسمك حين يكتمل الاتّصال بالخادم", "Your name will be saved once connected");
          setTimeout(function () { onbGo("code"); }, 600);
          return;
        }
        var p = nm === ((state.me && state.me.name) || "") ? Promise.resolve() : saveProfile({ name: nm });
        p.then(function () { lsSet("sawa_name_asked", Date.now()); onbGo("code"); })
          .catch(function (e) { err.textContent = codeErr(e); nx.disabled = false; btnText(nx, L("التالي", "Next")); });
      };
      inp.onkeydown = function (e) { if (e.key === "Enter") nx.onclick(); };
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 80);
      return;
    }
    if (step === "code") {
      b.appendChild(oTile("hash"));
      b.appendChild(hTitle(L("هذا رمزك في سوا", "This is your Sawa code")));
      var box = oc("div", "ob-code"); box.appendChild(mk("small", "", L("رمزك", "YOUR CODE")));
      var big = mk("div", "", "… … …"); box.appendChild(big);
      var waitNote = oc("div", "ob-p"); waitNote.style.cssText = "font-size:12px;opacity:.85;min-height:18px"; b.appendChild(waitNote);
      var waitT = setTimeout(function () { if (!state.uid) waitNote.textContent = L("جارٍ الاتّصال بالخادم… يمكنك المتابعة وسيظهر رمزك لاحقاً في «حسابي».", "Connecting… you can continue; your code will appear later in Me."); }, 2500);
      whenReady(function () { clearTimeout(waitT); waitNote.textContent = ""; });
      b.appendChild(box);
      b.appendChild(hSub(L("أعطه لمن تريد أن يتواصل معك. يرى اسمك فقط، ويرسل لك طلباً لا يُقبَل إلا بموافقتك.", "Give it to people you want to hear from. They see your name only and send a request you approve.")));
      var row = oc("div", "ob-row");
      var cp = bigBtn(L("نسخ", "Copy"), null, "copy"), sh = bigBtn(L("مشاركة", "Share"), null, "share");
      row.appendChild(cp); row.appendChild(sh); b.appendChild(row);
      var nx2 = bigBtn(L("التالي", "Next"), "white"); ft.appendChild(nx2);
      nx2.onclick = function () { onbGo("notify"); };
      whenReady(function () {
        loadCode().then(function (r) {
          big.textContent = fmtCode(r.code);
          cp.onclick = function () {
            copyText(fmtCode(r.code));
            cp.innerHTML = ""; cp.appendChild(oi("check")); cp.appendChild(mk("span", "", L("نُسخ", "Copied")));
            setTimeout(function () { cp.innerHTML = ""; cp.appendChild(oi("copy")); cp.appendChild(mk("span", "", L("نسخ", "Copy"))); }, 1600);
          };
          sh.onclick = function () { shareText(codeShareText(r.code)); };
        }).catch(function (e) { big.textContent = "—"; toast(codeErr(e)); });
      });
      return;
    }
    if (step === "notify") {
      if (pushState() !== "default") return onbGo("find");
      b.appendChild(oTile("bell", "ob-ring"));
      b.appendChild(hTitle(L("لا تفوّتك رسالةٌ أو مكالمة", "Don't miss a message or call")));
      b.appendChild(hSub(L("نُعلمك حين تصلك رسالة أو مكالمة أو طلب تواصل — حتّى والتطبيق مغلق.", "We'll tell you about messages, calls and requests — even when the app is closed.")));
      var nt = oc("div", "ob-notif"); nt.setAttribute("aria-hidden", "true");
      var ni = mk("img"); ni.src = "./icons/icon-192.png"; ni.alt = ""; nt.appendChild(ni);
      var nb = mk("div", "flex:1;min-width:0"), nh = mk("b", "", L("سوا", "Sawa")); nh.appendChild(mk("em", "", L("الآن", "now")));
      nb.appendChild(nh); nb.appendChild(mk("span", "", L("سارة: وصلتُ، أين أنت؟", "Sara: I'm here, where are you?"))); nt.appendChild(nb);
      b.appendChild(nt);
      var on = bigBtn(L("تفعيل الإشعارات", "Turn on notifications"), "white", "bell");
      var later = bigBtn(L("ليس الآن", "Not now"), "link");
      ft.appendChild(on); ft.appendChild(later);
      on.onclick = function () { on.disabled = true; enablePush().then(function () { onbGo("install"); }); };
      later.onclick = function () { lsSet("sawa_push_asked", Date.now()); onbGo("install"); };
      return;
    }
    if (step === "install") {
      if (!installable()) return onbGo("find");
      installBody(b, ft, function () { onbGo("find"); }, true);
      return;
    }
    if (step === "find") {
      b.appendChild(oTile("users"));
      b.appendChild(hTitle(L("تواصل مع من تعرف", "Connect with people you know")));
      b.appendChild(hSub(L("أدخل رمز صديقٍ أو زميل، أو أرسل له رمزك ليضيفك.", "Enter a friend's code, or send them yours.")));
      var opts = oc("div", "ob-opts");
      var fc = oOpt("hash", L("أدخل رمز شخص", "Enter someone's code"), L("لديك رمز صديق؟ أضفه من هنا", "Got a friend's code? Add it here"));
      var inv = oOpt("send", L("أرسل رمزي لصديق", "Send my code to a friend"), L("عبر واتساب أو أيّ تطبيق", "Via WhatsApp or any app"));
      opts.appendChild(fc); opts.appendChild(inv); b.appendChild(opts);
      var done = bigBtn(L("ابدأ استخدام سوا", "Start using Sawa"), "white"); done.appendChild(oc("span", "ob-fwd", "")).appendChild(oi("arrow"));
      ft.appendChild(done);
      fc.onclick = function () { findSheet(); };
      inv.onclick = function () { loadCode().then(function (r) { shareText(codeShareText(r.code)); }, function (e) { toast(codeErr(e)); }); };
      done.onclick = onbDone;
      return;
    }
    onbGo("welcome");
  }
  // C39: محتوى شاشة التثبيت — onb=true داخل شاشات البداية (زجاجيّ)، وإلّا ورقة بيضاء
  function installBody(b, ft, onNext, inOnb) {
    var st = installState();
    if (inOnb) b.appendChild(oTile("download"));
    b.appendChild(hTitle(L("ثبّت سوا على هاتفك", "Install Sawa on your phone")));
    b.appendChild(hSub(st === "ios-other"
      ? L("على آيفون يُثبَّت من متصفّح Safari فقط. انسخ الرابط وافتحه في Safari ثمّ اتبع الخطوات.", "On iPhone, installing works only from Safari. Copy the link, open it in Safari, then follow the steps.")
      : L("يصير سوا تطبيقاً بشعاره على الشاشة الرئيسيّة: يفتح بلا شريط عنوان، وتصلك المكالمات والرسائل أسرع.", "Sawa becomes an app with its icon on your home screen: no address bar, and calls and messages reach you faster.")));
    var hm = oc("div", "ob-home"); var hi = mk("img"); hi.src = "./icons/icon-192.png"; hi.alt = ""; hm.appendChild(hi);
    var ht = mk("div"); ht.appendChild(mk("b", "", L("سوا", "Sawa"))); ht.appendChild(mk("small", "", L("على الشاشة الرئيسيّة", "On your home screen"))); hm.appendChild(ht);
    if (inOnb) b.appendChild(hm);
    if (st !== "android-prompt") {
      var ul = oc("div", "ob-steps");
      installSteps(st).forEach(function (x, k) {
        var r = oc("div", "ob-step"); r.appendChild(oc("span", "ob-num", arNum(k + 1)));
        var fi = oc("span", "ob-fi"); fi.appendChild(oi(x[0])); r.appendChild(fi);
        r.appendChild(mk("span", "", x[1])); ul.appendChild(r);
      });
      b.appendChild(ul);
    }
    var main;
    if (st === "android-prompt") {
      main = bigBtn(L("تثبيت التطبيق", "Install app"), "white", "download");
      main.onclick = function () { main.disabled = true; installNow().then(function (r) { main.disabled = false; if (r === "accepted") { toast(L("تمّ التثبيت ✓ — افتح سوا من الشاشة الرئيسيّة", "Installed ✓ — open Sawa from your home screen")); onNext(); } else if (r === "none") { onbInstallRefresh(b, ft, onNext, inOnb); } }); };
      ft.appendChild(main);
    } else if (st === "ios-other") {
      main = bigBtn(L("نسخ الرابط", "Copy link"), "white", "copy");
      main.onclick = function () { copyText(global.location.origin + "/"); toast(L("نُسخ الرابط — افتحه في Safari", "Link copied — open it in Safari")); };
      ft.appendChild(main);
    }
    var later = bigBtn(inOnb ? L(st === "android-prompt" ? "ليس الآن" : "فهمت، تابع", st === "android-prompt" ? "Not now" : "Got it, continue") : L("إغلاق", "Close"), inOnb ? "link" : "white");
    later.onclick = function () { lsSet("sawa_install_skip", Date.now()); onNext(); };
    ft.appendChild(later);
    // إن وصل beforeinstallprompt بعد رسم الشاشة (أندرويد) نُعيد الرسم بزرّ التثبيت
    var re = function () { global.removeEventListener("sawa-install-state", re); if (document.body.contains(b)) onbInstallRefresh(b, ft, onNext, inOnb); };
    global.addEventListener("sawa-install-state", re);
  }
  function onbInstallRefresh(b, ft, onNext, inOnb) { b.innerHTML = ""; ft.innerHTML = ""; installBody(b, ft, onNext, inOnb); }
  // ورقة التثبيت من الإعدادات (للمستخدم القديم الذي يفتح من المتصفّح)
  function installSheet() {
    if (!installable()) { toast(installState() === "installed" ? L("سوا مثبَّتٌ على هاتفك ✓", "Sawa is already installed ✓") : L("التثبيت متاحٌ من هاتفك المحمول", "Install from your phone")); return; }
    onbCss();
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center";
    var box = document.createElement("div"); box.className = "sawa-inst"; box.dir = isAr() ? "rtl" : "ltr";
    box.style.cssText = "background:#fff;color:#1f2937;border-radius:22px 22px 0 0;padding:14px 18px calc(16px + env(safe-area-inset-bottom,0px));width:100%;max-width:520px;max-height:88%;overflow-y:auto;font:500 14px/1.7 system-ui;text-align:center";
    box.appendChild(mk("div", "width:42px;height:5px;border-radius:3px;background:#e2e8f0;margin:0 auto 10px"));
    var body = mk("div"), foot = mk("div", "display:flex;flex-direction:column;gap:8px;margin-top:16px");
    var close = function () { try { ov.remove(); } catch (e) {} };
    installBody(body, foot, close, false);
    try { body.querySelector(".ob-h").style.cssText = "font:800 18px system-ui;color:#0f172a"; body.querySelector(".ob-p").style.cssText = "font:500 13.5px/1.7 system-ui;color:#475569;margin-top:6px"; } catch (e) {}
    foot.querySelectorAll("button").forEach(function (bt, k) { bt.style.cssText = "border:0;border-radius:14px;padding:13px;font:800 14px system-ui;display:flex;align-items:center;justify-content:center;gap:8px;" + (k === 0 && foot.children.length > 1 ? "background:#2F80C8;color:#fff" : "background:#f1f5f9;color:#1f2937"); });
    ov.onclick = function (e) { if (e.target === ov) close(); };
    box.appendChild(body); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
  }
  function onbDone() {
    if (!onb) return;
    if (onb.timer) clearInterval(onb.timer);
    lsSet("sawa_onboarded", Date.now()); lsSet("sawa_name_asked", Date.now());
    try { localStorage.removeItem("sawa_onb_step"); } catch (e) {}
    try { onb.el.remove(); } catch (e) {}
    onb = null;
    whenApp(function () { try { if (app.goTab) app.goTab("chats"); } catch (e) {} });
    if (pendingCode) { var c = pendingCode; pendingCode = null; whenReady(function () { findSheet(c); }); }
    if (pendingDelete) { pendingDelete = false; onbDeleteMode = false; whenReady(function () { setTimeout(deleteAccountSheet, 600); }); }
  }
  // ?code=… (رابط «رمزي») و ?requests=1 (إشعار طلب تواصل)
  // ---------- تأكيد البريد (حسابات البريد وكلمة المرور) ----------
  //  بعد إنشاء الحساب تُرسَل رسالة تأكيد · شريطٌ يوميّ لطيف حتّى يؤكَّد · العودة من الرابط (?verified=1) ⇒ تحديث الحالة
  function emailUser() {
    try { var u = firebase.auth().currentUser; if (!u || u.isAnonymous || !u.email) return null;
      return (u.providerData || []).some(function (p) { return p && p.providerId === "password"; }) ? u : null; } catch (e) { return null; }
  }
  function sendVerify(silent) {
    var u = emailUser(); if (!u) return Promise.resolve(false);
    return u.sendEmailVerification({ url: global.location.origin + "/?verified=1" }).then(function () {
      lsSet("sawa_verify_sent", Date.now());
      toast(L("أرسلنا رابط تأكيدٍ إلى ", "We sent a confirmation link to ") + u.email + L(" — تفقّد الرسائل غير المرغوبة أيضاً", " — check spam too"));
      return true;
    }).catch(function (e) {
      if (!silent) toast(e && e.code === "auth/too-many-requests" ? L("أُرسل رابطٌ قبل قليل — انتظر ثمّ أعد المحاولة", "A link was sent recently — try again later") : L("تعذّر الإرسال: ", "Couldn't send: ") + ((e && (e.code || e.message)) || e));
      return false;
    });
  }
  var verifyEl = null;
  function maybeVerifyBanner() {
    var u = emailUser();
    if (!u || u.emailVerified || verifyEl || onbActive() || !document.body) return;
    if (lsGet("sawa_verify_asked", 0) > Date.now() - 86400000) return;
    verifyEl = bannerShell(); verifyEl.style.bottom = ""; verifyEl.style.top = "calc(10px + env(safe-area-inset-top,0px))"; verifyEl.style.background = "#8a5a00";
    var txt = mk("div", "flex:1", L("📧 أكّد بريدك ", "📧 Confirm ") + u.email + L(" لتستطيع استعادة حسابك", " so you can recover your account"));
    var yes = btn(L("إرسال الرابط", "Send link"), true), no = btn(L("لاحقاً", "Later"));
    var close = function () { lsSet("sawa_verify_asked", Date.now()); try { verifyEl.remove(); } catch (e) {} verifyEl = null; };
    yes.onclick = function () { close(); sendVerify(false); };
    no.onclick = close;
    verifyEl.appendChild(txt); verifyEl.appendChild(yes); verifyEl.appendChild(no); document.body.appendChild(verifyEl);
  }
  function handleVerifiedParam() {
    if (!/[?&]verified=1(&|$)/.test(global.location.search)) return;
    try { var u0 = new URL(global.location.href); u0.searchParams.delete("verified"); global.history.replaceState(null, "", u0.pathname + (u0.search ? u0.search : "") + u0.hash); } catch (e) {}
    whenReady(function () {
      var u = emailUser(); if (!u) return;
      u.reload().then(function () {
        var v = firebase.auth().currentUser;
        toast(v && v.emailVerified ? L("تمّ تأكيد بريدك ✓", "Email confirmed ✓") : L("لم يُؤكَّد البريد بعد — افتح الرابط من رسالة التأكيد", "Not confirmed yet — open the link in the email"));
      }).catch(function () {});
    });
  }
  function handleCodeParams() {
    var q; try { q = new URLSearchParams(global.location.search); } catch (e) { return; }
    var code = q.get("code"), rq = q.get("requests");
    if (!code && !rq) return;
    try { var u = new URL(global.location.href); u.searchParams.delete("code"); u.searchParams.delete("requests"); global.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash); } catch (e) {}
    if (code) {
      var d = codeDigits(code);
      if (onb || onbNeeded()) pendingCode = d;
      else whenReady(function () { setTimeout(function () { findSheet(d); }, 700); });
    }
    if (rq) whenReady(function () { setTimeout(requestsSheet, 700); });
  }

  // ---------- الإقلاع ----------
  var readyCbs = [];
  function whenReady(f) { if (state.uid) f(state.uid); else readyCbs.push(f); }
  function onUid(uid) {
    if (!uid || uid === state.uid) return;
    // تغيّر الهويّة (ربط Google): نبدأ من جديد
    for (var u in presenceRefs) { try { presenceRefs[u].off(); } catch (e) {} }
    presenceRefs = {}; state.presence = {}; state.people = []; state.loaded = false;
    state.uid = uid;
    var c = lsGet("sawa_people_cache", null);
    if (c && c.uid === uid) { state.me = c.me; state.people = c.people || []; publish(); }
    else { state.me = null; try { if (app && app.setMyProfile) app.setMyProfile(null); if (app && app.setPeople) app.setPeople([]); } catch (e) {}
      // C14: حسابٌ آخر على هذا الجهاز ⇒ وسائط الحساب السابق المنزّلة تُمسح
      if (c && c.uid) { try { idbP = null; if (global.indexedDB) indexedDB.deleteDatabase("sawa-media"); } catch (e) {} } }
    state.cachedUid = null;
    startMyPresence(uid);
    // C57: اسمٌ كُتب في شاشة البداية قبل أن تجهز الهويّة
    (function () { var pn = lsGet("sawa_pending_name", null); if (pn) { saveProfile({ name: pn }).then(function () { try { localStorage.removeItem("sawa_pending_name"); } catch (e) {} }).catch(function () {}); } })();
    // C53: طلب boot واحد يحمل جهات الاتّصال والتفضيلات والطلبات معاً؛ إن تعذّر نعود للطلبات الثلاثة
    var bootUid = uid;
    state.loading = true;
    call("boot", {}).then(function (b) {
      state.loading = false; if (state.uid !== bootUid) return;
      if (b.people) applyPeople(b.people); else refresh();
      if (b.prefs) loadPrefs(b.prefs); else loadPrefs();
      if (b.requests) loadRequests(b.requests); else setTimeout(loadRequests, 2500);
    }).catch(function () { state.loading = false; if (state.uid !== bootUid) return; refresh(); loadPrefs(); setTimeout(loadRequests, 2500); });
    stopChats(); prefs = null; prefsLoaded = false; pend = {}; virtualChats = {};
    adminP = null; avWant = {}; avFetching = {};
    plain = {}; decQ = {}; mediaKeys = {}; chatsLoaded = false; missingSince = {}; keyFp = {}; knownSec = null; e2e.reset();   // C23
    e2e.load().then(function () { publishChats(); Object.keys(days).forEach(publishMessages); }, function () { publishChats(); });
    restorePending(); startChats(uid); drainOutbox();
    setTimeout(refreshPush, 3000);
    setTimeout(maybeVerifyBanner, 6000);
    var cbs = readyCbs; readyCbs = [];
    cbs.forEach(function (f) { try { f(uid); } catch (e) {} });
  }
  function boot() {
    // ?delete=1 (رابط «حذف الحساب» لـGoogle Play): جهازٌ جديد ⇒ شاشة الدخول وحدها ثمّ نافذة الحذف
    try {
      if (/[?&]delete=1(&|$)/.test(global.location.search)) {
        var du = new URL(global.location.href); du.searchParams.delete("delete"); global.history.replaceState(null, "", du.pathname + (du.search ? du.search : "") + du.hash);
        pendingDelete = true;
        if (onbNeeded()) { onbDeleteMode = true; lsSet("sawa_onb_step", "login"); }
        else whenReady(function () { setTimeout(function () { if (pendingDelete) { pendingDelete = false; deleteAccountSheet(); } }, 900); });
      }
    } catch (e) {}
    try { if (onbNeeded()) onbStart(); } catch (e) { log("onboarding:", e && e.message); }
    handleCodeParams();
    handleVerifiedParam();
    handleContactParam();
    handleGroupParam();
    handleChatParam();
    var tries = 0;
    (function wait() {
      if (S() && S().onReady) {
        S().onReady(function (uid) {
          onUid(uid);
          try {
            if (!authUnsub) authUnsub = firebase.auth().onAuthStateChanged(function (u) { if (u && u.uid !== state.uid) onUid(u.uid); });
          } catch (e) {}
        });
        return;
      }
      if (++tries < 100) setTimeout(wait, 100);
    })();
  }

  // ==================================================================
  // C23: المحادثات السرّيّة — تشفيرٌ بين الطرفين (WebCrypto)
  //  - لكلّ جهازٍ مفتاح ECDH P-256 يُولَّد فيه ولا يغادره (IndexedDB «sawa-e2e»، والمفتاح الخاصّ غير قابلٍ للتصدير).
  //  - كلّ رسالة: مفتاح AES-GCM-256 عشوائيّ يشفّر المحتوى كلّه (النصّ، الاقتباس، جهة الاتّصال، اسم الوسيط ومفتاحه وصورته المصغّرة)،
  //    ثمّ يُغلَّف ذلك المفتاح لكلّ جهازٍ مربوط (ولجهازي) بمفتاحٍ مشترك: ECDH ⇒ HKDF-SHA256 ⇒ AES-GCM.
  //  - AAD يربط النصّ المشفّر بالمحادثة والرسالة والمرسل وجهازه: لا يستطيع الخادم نقله إلى محادثةٍ أخرى ولا نسبته لغير صاحبه.
  //  - الوسائط تُشفَّر بمفتاحٍ خاصّ قبل الرفع؛ الخادم يرى حجمها فقط.
  //  - رمز الأمان: SHA-512 لمفتاحي الجهازين ⇒ ٦٠ رقماً يقارنها الطرفان. ومفتاح كلّ جهازٍ يُثبَّت عند أوّل رؤية (لا يُبدَّل بصمت).
  //  - الحدود (نقولها بصراحة): لا «سرّيّة أماميّة» — مفاتيح الأجهزة ثابتة؛ والخادم يرى من يراسل من ومتى وحجم الرسائل والتفاعلات.
  // ==================================================================
  var e2e = (function () {
    var CR = global.crypto, subtle = CR && CR.subtle;
    var te = typeof TextEncoder !== "undefined" ? new TextEncoder() : null, td = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    function ok() { return !!(subtle && te && td && CR.getRandomValues && (global.__sawaE2eStore || global.indexedDB)); }
    function b64(buf) { var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
    function unb64(s) { var bin = atob(String(s || "")), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    function rnd(n) { var u = new Uint8Array(n); CR.getRandomValues(u); return u; }
    function cat(a, b) { var x = new Uint8Array(a), y = new Uint8Array(b), u = new Uint8Array(x.length + y.length); u.set(x, 0); u.set(y, x.length); return u; }
    function hex(u) { var s = ""; for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? "0" : "") + u[i].toString(16); return s; }
    // معرّف الجهاز = أوّل ١٢ بايت من SHA-256 لمفتاحه العامّ (الخادم يتحقّق أيضاً): لا ينتحل أحدٌ معرّف جهاز غيره
    function devIdOf(pub) { return subtle.digest("SHA-256", unb64(pub)).then(function (h) { return hex(new Uint8Array(h).slice(0, 12)); }); }
    var devChk = {};
    function devMatches(d, pub) { var k = d + "|" + pub; return devChk[k] || (devChk[k] = devIdOf(pub).then(function (x) { return x === d; }, function () { return false; })); }
    function bufOf(blob) {
      if (blob.arrayBuffer) return blob.arrayBuffer();
      return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsArrayBuffer(blob); });
    }
    // ---- مخزن المفاتيح (لكلّ حسابٍ على الجهاز مفتاحه) ----
    var dbP = null;
    function store() {
      if (global.__sawaE2eStore) return Promise.resolve(global.__sawaE2eStore);   // للاختبار
      if (dbP) return dbP;
      dbP = new Promise(function (res, rej) {
        try {
          var r = indexedDB.open("sawa-e2e", 1);
          r.onupgradeneeded = function () { r.result.createObjectStore("k"); };
          r.onsuccess = function () {
            var d = r.result;
            res({
              get: function (k) { return new Promise(function (y, n) { try { var q = d.transaction("k").objectStore("k").get(k); q.onsuccess = function () { y(q.result || null); }; q.onerror = function () { n(q.error); }; } catch (e) { n(e); } }); },
              put: function (k, v) { return new Promise(function (y, n) { try { var t = d.transaction("k", "readwrite"); t.objectStore("k").put(v, k); t.oncomplete = function () { y(); }; t.onerror = function () { n(t.error); }; t.onabort = function () { n(t.error); }; } catch (e) { n(e); } }); }
            });
          };
          r.onerror = function () { dbP = null; rej(new Error("e2e storage")); };
        } catch (e) { dbP = null; rej(new Error("e2e storage")); }
      });
      return dbP;
    }
    var mine = {}, making = {}, myDev = null, loaded = false;
    function myKey(create) {
      var uid = state.uid;
      if (!uid) return Promise.reject(new Error("not ready"));
      if (!ok()) return Promise.reject(new Error("e2e unsupported"));
      var p = mine[uid] || (mine[uid] = store().then(function (s) { return s.get("u:" + uid); }).catch(function (e) { delete mine[uid]; throw e; }));
      return p.then(function (k) {
        if (uid === state.uid) { myDev = k ? k.d : null; loaded = true; }
        if (k || !create) return k;
        if (making[uid]) return making[uid];
        return (making[uid] = subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]).then(function (kp) {
          return subtle.exportKey("raw", kp.publicKey).then(function (raw) { return devIdOf(b64(raw)).then(function (d) { return { raw: raw, d: d }; }); }).then(function (x) {
            var rec = { d: x.d, priv: kp.privateKey, pub: b64(x.raw), ts: Date.now() };
            return store().then(function (s) { return s.put("u:" + uid, rec).then(function () { return s.get("u:" + uid); }); }).then(function (back) {
              if (!back || back.d !== rec.d) throw new Error("e2e storage");   // لم يُحفظ فعلاً (نافذة خاصّة…) ⇒ لا نربط جهازاً سيفقد مفتاحه
              pinOk(back.d, back.pub);
              mine[uid] = Promise.resolve(back); delete making[uid];
              if (uid === state.uid) myDev = back.d;
              return back;
            });
          });
        }).catch(function (e) { delete making[uid]; throw e; }));
      });
    }
    // ---- المفاتيح المشتركة بين جهازين ----
    var keks = {};
    function kek(me, dev, pub) {
      var id = me.d + "|" + dev + "|" + pub;
      if (!keks[id]) keks[id] = subtle.importKey("raw", unb64(pub), { name: "ECDH", namedCurve: "P-256" }, false, [])
        .then(function (pk) { return subtle.deriveBits({ name: "ECDH", public: pk }, me.priv, 256); })
        .then(function (bits) { return subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]); })
        .then(function (hk) { return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode("sawa-e2e-v1"), info: te.encode([me.d, dev].sort().join("|")) }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); })
        .catch(function (e) { delete keks[id]; throw e; });
      return keks[id];
    }
    // مفتاح كلّ جهازٍ يُثبَّت عند أوّل رؤية: إن عرض الخادم لاحقاً مفتاحاً آخر للجهاز نفسه نرفضه
    function pinOk(dev, pub) {
      var p = lsGet("sawa_e2e_pins", {});
      if (!p[dev]) { p[dev] = pub; var ks = Object.keys(p); if (ks.length > 800) delete p[ks[0]]; lsSet("sawa_e2e_pins", p); return true; }
      return p[dev] === pub;
    }
    function targets(c, me) {   // Promise<[{d, k}]> لكلّ عضوٍ ربط جهازاً — وجهازي منها بمفتاحي أنا لا بنسخة الخادم
      var e = c.e2e || {}, devs = e.devs || {}, keys = e.keys || {};
      if (c.type === "dm" && (c.members || []).length !== 2) return Promise.reject(new Error("secret chat broken"));
      return Promise.all((c.members || []).map(function (u) {
        var d = devs[u], k = d && keys[d];
        if (!k) return null;
        if (d === me.d) return u === state.uid && k.u === u && k.k === me.pub ? { d: d, k: me.pub } : null;
        if (u === state.uid || k.u !== u || !k.k || !pinOk(d, k.k)) return null;
        return devMatches(d, k.k).then(function (okd) { return okd ? { d: d, k: k.k } : null; });
      })).then(function (l) { return l.filter(Boolean); });
    }
    function aadMsg(cid, id, by, dev) { return te.encode(["sawa-e2e-v1", cid, id, by, dev].join("|")); }
    function encrypt(c, id, plain) {
      return myKey(false).then(function (me) {
        if (!me) throw new Error("e2e: no key on this device");
        if (!(c.e2e && c.e2e.on)) throw new Error("secret chat broken");
        if (((c.e2e || {}).devs || {})[state.uid] !== me.d) throw new Error("e2e device not bound");
        var ts, K = rnd(32), iv = rnd(12);
        return targets(c, me).then(function (l) {
          ts = l;
          if (!ts.some(function (t) { return t.d === me.d; })) throw new Error("e2e device not bound");
          return subtle.importKey("raw", K, "AES-GCM", false, ["encrypt"]);
        })
          .then(function (ck) { return subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: aadMsg(c.cid, id, state.uid, me.d) }, ck, te.encode(JSON.stringify(plain))); })
          .then(function (ct) {
            return Promise.all(ts.map(function (t) {
              return kek(me, t.d, t.k).then(function (kk) {
                var wiv = rnd(12);
                return subtle.encrypt({ name: "AES-GCM", iv: wiv, additionalData: te.encode(c.cid + "|" + id) }, kk, K).then(function (w) { return [t.d, b64(cat(wiv, w))]; });
              });
            })).then(function (pairs) { var k = {}; pairs.forEach(function (x) { k[x[0]] = x[1]; }); K.fill(0); return { v: 1, d: me.d, iv: b64(iv), ct: b64(ct), k: k }; });
          });
      });
    }
    function decrypt(c, m) {
      return myKey(false).then(function (me) {
        if (!me) throw new Error("nokey");
        var en = m.enc || {}, w = en.k && en.k[me.d];
        if (!w) throw new Error("notforme");
        var sk = en.d === me.d ? (m.by === state.uid ? { u: state.uid, k: me.pub } : null) : ((c.e2e || {}).keys || {})[en.d];
        if (!sk || sk.u !== m.by || !pinOk(en.d, sk.k)) throw new Error("badsender");
        var raw = unb64(w);
        return devMatches(en.d, sk.k).then(function (okd) { if (!okd) throw new Error("badsender"); return kek(me, en.d, sk.k); })
          .then(function (kk) { return subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: te.encode(c.cid + "|" + m.id) }, kk, raw.slice(12)); })
          .then(function (K) { return subtle.importKey("raw", K, "AES-GCM", false, ["decrypt"]); })
          .then(function (ck) { return subtle.decrypt({ name: "AES-GCM", iv: unb64(en.iv), additionalData: aadMsg(c.cid, m.id, m.by, en.d) }, ck, unb64(en.ct)); })
          .then(function (pt) { var o = JSON.parse(td.decode(pt)); if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("bad"); return o; });
      });
    }
    function encFile(blob) {
      var fk = rnd(32), fiv = rnd(12);
      return bufOf(blob).then(function (buf) { return subtle.importKey("raw", fk, "AES-GCM", false, ["encrypt"]).then(function (k) { return subtle.encrypt({ name: "AES-GCM", iv: fiv }, k, buf); }); })
        .then(function (ct) { return { blob: new Blob([ct], { type: "application/octet-stream" }), fk: b64(fk), fiv: b64(fiv) }; });
    }
    function decFile(blob, fk, fiv, mime) {
      return bufOf(blob).then(function (buf) { return subtle.importKey("raw", unb64(fk), "AES-GCM", false, ["decrypt"]).then(function (k) { return subtle.decrypt({ name: "AES-GCM", iv: unb64(fiv) }, k, buf); }); })
        .then(function (pt) { return new Blob([pt], { type: mime || "application/octet-stream" }); });
    }
    function safety(pubA, pubB) {
      var a = [pubA, pubB].sort();
      return subtle.digest("SHA-512", cat(unb64(a[0]), unb64(a[1]))).then(function (h) {
        var b = new Uint8Array(h), out = [];
        for (var i = 0; i < 12; i++) { var n = 0; for (var j = 0; j < 5; j++) n = (n * 256 + b[i * 5 + j]) % 100000; out.push(String(n).padStart(5, "0")); }
        return out;
      });
    }
    function load() { return myKey(false).catch(function (e) { loaded = true; throw e; }); }
    return { ok: ok, myKey: myKey, load: load, devIdOf: devIdOf, myDev: function () { return myDev; }, loaded: function () { return loaded; }, encrypt: encrypt, decrypt: decrypt,
      encFile: encFile, decFile: decFile, safety: safety, reset: function () { myDev = null; loaded = false; keks = {}; } };
  })();

  // ---- حالة المحادثة السرّيّة وواجهتها ----
  var plain = {}, decQ = {}, mediaKeys = {}, chatsLoaded = false, missingSince = {};
  var knownSec = null;
  function knownSecret(cid) { if (!knownSec) knownSec = lsGet("sawa_e2e_known", {}); return /^sdm_/.test(String(cid || "")) || !!knownSec[cid]; }
  function rememberSecret(cid) { knownSecret(cid); if (knownSec[cid]) return; knownSec[cid] = 1; lsSet("sawa_e2e_known", knownSec); }
  // C24: مدير التطبيق (الخادم يقرّر بـADMIN_EMAIL) — لإظهار «فحص الاتّصال» له وحده
  var adminP = null;
  function adminCached() { var a = lsGet("sawa_admin", null); return !!(a && a.uid === state.uid && a.v); }
  function checkAdmin() {
    if (!state.uid) return new Promise(function (res) { whenReady(function () { checkAdmin().then(res); }); });
    if (!adminP) adminP = call("whoami", {}).then(function (b) { var v = !!(b && b.admin === true); lsSet("sawa_admin", { uid: state.uid, v: v }); return v; },
      function () { adminP = null; return adminCached(); });
    return adminP;
  }
  function e2eOn(c) { return !!(c && ((c.e2e && c.e2e.on) || knownSecret(c.cid))); }
  function e2eIntact(c) { return !!(c && c.e2e && c.e2e.on && (c.type !== "dm" || (c.members || []).length === 2)); }
  function maybeSecret(cid) { return /^(sdm_|grp_)/.test(String(cid || "")); }
  function e2eState(c) {
    if (!e2eOn(c)) return null;
    if (!e2eIntact(c)) return "broken";
    if (!e2e.ok()) return "unsupported";
    if (!e2e.loaded()) return "loading";
    var devs = c.e2e.devs || {}, my = e2e.myDev();
    if (!devs[state.uid]) return "join";
    if (devs[state.uid] !== my) return "other";
    if (!others(c).some(function (u) { return devs[u]; })) return "waiting";
    return "ready";
  }
  function e2eUi(c) {
    var st = e2eState(c), group = c.type === "group", o = { cid: c.cid, state: st };
    if (st === "join") { o.title = group ? L("مجموعة سرّيّة", "Secret group") : L("دعوة لمحادثة سرّيّة", "Secret chat invitation");
      o.text = L("الرسائل هنا مشفّرة بين الأجهزة ولا يقرؤها خادم سوا. فعّلها على هذا الجهاز لتقرأ ما يُرسَل من الآن وتكتب.", "Messages here are end-to-end encrypted. Turn it on for this device to read new messages and reply.");
      o.action = L("تفعيل على هذا الجهاز", "Turn on for this device"); }
    else if (st === "other") { o.title = L("مفعّلة على جهازٍ آخر لك", "Active on another of your devices");
      o.text = L("هذه المحادثة السرّيّة مرتبطةٌ بجهازٍ آخر. رسائلها لا تُقرأ إلّا هناك.", "This secret chat lives on another device; its messages can only be read there.");
      o.action = L("نقلها إلى هذا الجهاز", "Move it to this device"); }
    else if (st === "waiting") { var os = others(c);
      o.title = group ? L("بانتظار الأعضاء", "Waiting for members") : L("بانتظار ", "Waiting for ") + personName(os[0], c);
      o.text = group ? L("تبدأ الكتابة حين يفعّلها عضوٌ آخر على جهازه.", "You can write once another member turns it on.") : L("تبدأ المراسلة حين يفتح الدعوة ويفعّلها على جهازه.", "You can write once they open the invitation on their device."); }
    else if (st === "unsupported") { o.title = L("غير مدعومة هنا", "Not supported here");
      o.text = L("هذا المتصفّح لا يتيح حفظ مفاتيح التشفير (ربّما نافذة خاصّة). افتح سوا في Chrome أو Safari العاديّ.", "This browser can't store encryption keys (private window?). Open Sawa in regular Chrome or Safari."); }
    else if (st === "loading") { o.title = L("🔒 …", "🔒 …"); o.text = ""; }
    else if (st === "broken") { o.title = L("⚠️ تحذير أمني", "⚠️ Security warning");
      o.text = L("تغيّرت إعدادات التشفير في هذه المحادثة على غير المعتاد، فأوقفنا الإرسال فيها حمايةً لك. ابدأ محادثةً سرّيّة جديدة.", "This chat's encryption settings changed unexpectedly, so sending is stopped. Start a new secret chat."); }
    return o;
  }
  function h32(x) { var h = 0x811c9dc5; for (var i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  // مفتاح ذاكرة الفكّ: كلّ ما يدخل في التحقّق (المرسل، جهازه، النصّ المشفّر كلّه، غلاف مفتاحي) — أيّ تغييرٍ من الخادم يُعاد فحصه
  var NOTES = "sawa_e2e_notes", SEEN = "sawa_e2e_seen", keyFp = {};
  function e2eWatch() {
    var seen = lsGet(SEEN, {}), notes = null, changed = false;
    Object.keys(chats).forEach(function (cid) {
      var c = chats[cid]; if (!(c.e2e && c.e2e.on)) return;
      rememberSecret(cid);
      var devs = c.e2e.devs || {}, was = seen[cid], now = {};
      (c.members || []).forEach(function (u) { if (devs[u]) now[u] = devs[u]; });
      if (was) Object.keys(now).forEach(function (u) {
        if (u === state.uid || !was[u] || was[u] === now[u]) return;
        notes = notes || lsGet(NOTES, {});
        (notes[cid] = (notes[cid] || []).slice(-19)).push({ id: "l" + Date.now().toString(36) + u.slice(0, 4), ts: Date.now(),
          text: L("🔐 تغيّر رمز الأمان مع " + personName(u, c) + " (جهازٌ جديد) — قارنه من جديد إن أردت التأكّد", "🔐 Your safety code with " + personName(u, c) + " changed (new device)") });
      });
      if (JSON.stringify(was || null) !== JSON.stringify(now)) { seen[cid] = now; changed = true; }
      // تغيّرت مفاتيح المحادثة ⇒ نعيد فحص ما فشل لأنّ مفتاح مرسله لم يكن معروفاً
      var fp = JSON.stringify(c.e2e.keys || {});
      if (keyFp[cid] !== undefined && keyFp[cid] !== fp) for (var pk in plain) if (pk.indexOf(cid + "|") === 0 && plain[pk] && plain[pk].err === "badsender") plain[pk].retry = true;
      keyFp[cid] = fp;
    });
    if (changed) lsSet(SEEN, seen);
    if (notes) { lsSet(NOTES, notes); Object.keys(days).forEach(publishMessages); }
    if (Object.keys(plain).length > 4000) plain = {};   // سقفٌ للذاكرة — يُعاد الفكّ عند الحاجة
  }
  function encKey(cid, m) { var en = m.enc || {}, ct = String(en.ct || ""); return [cid, m.id, m.by, en.d, en.iv, ct.length, h32(ct), h32(String((en.k || {})[e2e.myDev()] || ""))].join("|"); }
  var PREV = "sawa_e2e_prev";
  function notePreview(cid, m) {
    var c = chats[cid]; if (!c || !c.last || c.last.id !== m.id || c.disappear) return;
    var t = preview(plainOf(cid, m)); var all = lsGet(PREV, {});
    if (all[cid] && all[cid].id === m.id && all[cid].t === t) return;
    all[cid] = { id: m.id, t: String(t).slice(0, 120) }; var ks = Object.keys(all); if (ks.length > 300) delete all[ks[0]];
    lsSet(PREV, all);
  }
  function secretPreview(c) {
    var l = c.last, st = e2eState(c);
    if (st === "join") return L("🔒 دعوة لمحادثة سرّيّة — افتحها لتفعيلها", "🔒 Secret chat invitation — open to turn on");
    if (!l) return L("🔒 محادثة سرّيّة", "🔒 Secret chat");
    var pv = lsGet(PREV, {})[c.cid];
    if (pv && (l.del || c.disappear || pv.id !== l.id)) { var allp = lsGet(PREV, {}); delete allp[c.cid]; lsSet(PREV, allp); pv = null; }
    if (l.del) return preview(l);
    if (l.type === "system") return sysText({ by: l.by, extra: { ev: l.ev } }, c);
    if (pv && pv.id === l.id) return pv.t;
    return typeLabel(l.type) || L("🔒 رسالة مشفّرة", "🔒 Encrypted message");
  }
  function queueDecrypt(cid, m, k) {
    if (decQ[k]) return;
    var c = chats[cid]; if (!c) return;
    decQ[k] = 1;
    e2e.decrypt(c, m).then(function (p) { plain[k] = p; }, function (e) {
      var s = (e && e.message) || ""; plain[k] = { err: /^(notforme|nokey|badsender)$/.test(s) ? s : "fail" }; log("e2e:", m.id, s);
    }).then(function () { delete decQ[k]; notePreview(cid, m); publishMessages(cid); });
  }
  // الرسالة كما تُعرض: الحقول الموثوقة من الخادم (المعرّف، المرسل، الوقت، التفاعلات…) + المحتوى المفكوك
  function plainOf(cid, m) {
    var k = encKey(cid, m), p = plain[k];
    if (p === undefined) { queueDecrypt(cid, m, k); p = { pending: true }; }
    else if (p.retry) { p.retry = false; queueDecrypt(cid, m, k); }   // يبقى الخطأ معروضاً حتّى تنجح المحاولة (بلا وميض)
    var o = Object.assign({}, m); delete o.enc;
    if (p.pending || p.err) {
      o.type = "text"; delete o.extra; delete o.reply; o.e2eErr = true;
      o.text = p.pending ? L("🔒 جارٍ فكّ التشفير…", "🔒 Decrypting…")
        : p.err === "notforme" || p.err === "nokey" ? L("🔒 أُرسلت قبل تفعيل المحادثة على هذا الجهاز", "🔒 Sent before this device joined")
        : L("🔒 تعذّر فكّ تشفير هذه الرسالة", "🔒 Couldn't decrypt this message");
      return o;
    }
    if (typeof p.text === "string") o.text = p.text.slice(0, 4000); else delete o.text;
    if (p.contact && typeof p.contact === "object" && /^[A-Za-z0-9_-]{1,128}$/.test(String(p.contact.uid || ""))) o.contact = { uid: String(p.contact.uid), name: String(p.contact.name || "").slice(0, 80) };
    else delete o.contact;
    if (m.reply) {
      var rt = p.reply && typeof p.reply.text === "string" ? p.reply.text : "";
      if (!rt) { var rf = findMsg(cid, m.reply.id); var rp = rf && rf.msg.enc ? plain[encKey(cid, rf.msg)] : null; if (rp && typeof rp.text === "string") rt = rp.text; }   // الاقتباس من نسختي المفكوكة
      o.reply = { id: m.reply.id, day: m.reply.day || null, by: p.reply && typeof p.reply.by === "string" ? p.reply.by : null, text: rt.slice(0, 200) };
    }
    if (m.type === "location") {
      var lx = p.extra || {}, la = Number(lx.lat), ln = Number(lx.lng);
      if (!(la >= -90 && la <= 90 && ln >= -180 && ln <= 180)) { o.type = "text"; o.e2eErr = true; o.text = L("🔒 تعذّر فكّ تشفير هذه الرسالة", "🔒 Couldn't decrypt this message"); delete o.extra; return o; }
      o.extra = { lat: la, lng: ln, acc: Number(lx.acc) || null, label: typeof lx.label === "string" ? lx.label.slice(0, 120) : null };
    }
    if (MEDIA_TYPES.indexOf(m.type) >= 0) {
      var sx = m.extra || {}, px = p.extra || {}, num = function (v) { return typeof v === "number" && isFinite(v) && v >= 0 ? v : null; };
      if (!sx.mid || px.mid !== sx.mid) { o.type = "text"; delete o.extra; o.e2eErr = true; o.text = L("🔒 تعذّر فكّ تشفير هذه الرسالة", "🔒 Couldn't decrypt this message"); return o; }   // الخادم لا يربط الرسالة بوسيطٍ آخر
      var ex = { mid: sx.mid, viewOnce: !!sx.viewOnce };
      if (typeof px.name === "string") ex.name = px.name.slice(0, 200);
      if (typeof px.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(px.mime)) ex.mime = px.mime.slice(0, 100);
      ["size", "duration", "w", "h"].forEach(function (f) { var v = num(px[f]); if (v != null) ex[f] = v; });
      if (typeof px.transcript === "string") ex.transcript = px.transcript.slice(0, 1500);
      if (!sx.viewOnce && typeof px.thumb === "string" && px.thumb.length <= 9000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(px.thumb)) ex.thumb = px.thumb;   // لا روابط خارجيّة (تتبّع)
      if (typeof px.fk === "string" && typeof px.fiv === "string") mediaKeys[cid + "|" + sx.mid] = { fk: px.fk, fiv: px.fiv, mime: ex.mime || null };
      o.extra = ex;
    }
    return o;
  }
  // ما يُرسَل للخادم: المحتوى كلّه داخل enc، وخارجه ما يحتاجه الخادم فقط (معرّف الوسيط، «مرّة واحدة»، الإشارات، يوم الاقتباس)
  function wireOf(job) {
    var c = chats[job.cid];
    if (!c) {
      if (maybeSecret(job.cid) && !virtualChats[job.cid]) {   // لا نرسل نصّاً ظاهراً قبل أن نعرف أنّ المحادثة ليست سرّيّة
        var t0 = missingSince[job.cid] || (missingSince[job.cid] = Date.now());
        if (chatsLoaded && Date.now() - t0 > 60000) return Promise.reject(new Error("chat not found"));
        return Promise.reject(new Error("e2e: chat not loaded yet"));
      }
      return Promise.resolve(job.msg);
    }
    delete missingSince[job.cid];
    if (!e2eOn(c)) return Promise.resolve(job.msg);
    if (!e2eIntact(c)) return Promise.reject(new Error("secret chat broken"));
    var m = job.msg, w = { id: m.id, type: m.type || "text" }, p = {};
    if (m.text != null) p.text = m.text;
    if (m.contact) p.contact = m.contact;
    if (m.reply) { p.reply = { id: m.reply.id, by: m.reply.by || null, text: m.reply.text || "" }; w.reply = { id: m.reply.id, day: m.reply.day || null }; }
    if (m.extra) { p.extra = m.extra; if (m.extra.mid) w.extra = { mid: m.extra.mid }; if (m.extra.viewOnce) (w.extra = w.extra || {}).viewOnce = true; }
    if (m.fwd) w.fwd = true;
    if (m.mentions) w.mentions = m.mentions;
    return e2e.encrypt(c, m.id, p).then(function (en) { w.enc = en; return w; });
  }
  function e2eErrText(e) {
    var m = (e && e.message) || String(e);
    if (/not a contact/.test(m)) return L("لا يمكن بدء محادثة سرّيّة مع هذا الشخص — يجب أن يكون في جهات اتّصالك", "You can only start a secret chat with your contacts");
    if (/e2e (unsupported|storage)/.test(m)) return L("هذا المتصفّح لا يتيح حفظ مفاتيح التشفير (ربّما نافذة خاصّة)", "This browser can't store encryption keys (private window?)");
    if (/rate_limited/.test(m)) return L("محاولاتٌ كثيرة — انتظر قليلاً", "Too many attempts — wait a bit");
    if (/unknown op|bad op/.test(m)) return L("الخادم لم يُحدَّث بعد لدعم المحادثات السرّيّة", "The server doesn't support secret chats yet");
    if (/device not bound/.test(m)) return L("المحادثة السرّيّة ليست مفعّلة على هذا الجهاز", "This secret chat isn't active on this device");
    return L("تعذّر: ", "Failed: ") + m;
  }
  function e2eNeedSupport() {
    if (e2e.ok()) return true;
    toast(L("هذا المتصفّح لا يدعم المحادثات السرّيّة — افتح سوا في Chrome أو Safari العاديّ", "This browser doesn't support secret chats"));
    return false;
  }
  function e2eExplain(box) {
    box.appendChild(note(L("🔒 الرسائل والصور والصوتيّات تُشفَّر على جهازك، ولا يفكّها إلّا أجهزة أطراف المحادثة. خادم سوا لا يستطيع قراءتها.",
      "🔒 Messages, photos and voice notes are encrypted on your device and only the participants' devices can read them. Sawa's server can't.")));
    box.appendChild(note(L("تبقى على هذا الجهاز: إن غيّرت هاتفك أو مسحت بيانات التطبيق أو خرجت من حسابك فلن تُستعاد رسائلها السابقة.",
      "It stays on this device: if you change phones, clear app data or sign out, earlier messages can't be recovered."), "#8a5a00", "#fff7e0"));
  }
  function openWhenListed(cid) {
    var n = 0;
    (function w() {
      if (chats[cid] || n++ > 30) { setTimeout(function () { whenApp(function () { try { if (app.openChatById) app.openChatById(cid); } catch (e) {} }); }, 350); return; }
      setTimeout(w, 200);
    })();
  }
  function e2eCreateDm(uid) {
    return e2e.myKey(true).then(function (k) { return call("e2e.dm", { to: uid, d: k.d, k: k.pub }); }).then(function (b) { openWhenListed(b.cid); return b.cid; });
  }
  function e2eCreateGroup(name, ids) {
    return e2e.myKey(true).then(function (k) { return call("e2e.group", { name: String(name || "").trim().slice(0, 80), members: ids, e2e: { d: k.d, k: k.pub } }); })
      .then(function (b) { if (!b || !b.e2e) throw new Error("unknown op"); openWhenListed(b.cid); return b.cid; });
  }
  function e2eJoin(cid) {
    return e2e.myKey(true).then(function (k) { return call("e2e.join", { cid: cid, d: k.d, k: k.pub }); }).then(function (b) { publishChats(); return b; });
  }
  function e2eStartDm(uid) {
    if (!state.uid || !uid || !e2eNeedSupport()) return;
    var s = sheet(L("محادثة سرّيّة مع ", "Secret chat with ") + personName(uid));
    e2eExplain(s.box);
    var go = mkBtn(L("ابدأ المحادثة السرّيّة", "Start the secret chat"), "primary"); go.style.marginTop = "8px";
    go.onclick = function () {
      go.disabled = true; go.textContent = "…";
      e2eCreateDm(uid).then(function () { s.close(); }).catch(function (e) { go.disabled = false; go.textContent = L("ابدأ المحادثة السرّيّة", "Start the secret chat"); toast(e2eErrText(e)); });
    };
    s.box.appendChild(go);
  }
  function e2eNewSheet() {
    if (!state.uid || !e2eNeedSupport()) return;
    var s = sheet(L("محادثة سرّيّة جديدة", "New secret chat"));
    e2eExplain(s.box);
    var ppl = (state.people || []).filter(function (p) { return p && p.uid && p.uid !== state.uid; });
    if (!ppl.length) { s.box.appendChild(note(L("أضف جهات اتّصال أوّلاً من «جهات الاتّصال».", "Add contacts first."))); return; }
    s.box.appendChild(mk("div", "font:800 13px system-ui;margin:10px 2px 4px", L("اختر شخصاً لمحادثة، أو عدّة أشخاص لمجموعة", "Pick one person for a chat, or several for a group")));
    var list = mk("div", "max-height:36vh;overflow-y:auto;margin:4px 0;border:1px solid #eef1f4;border-radius:12px"), picked = {};
    var nameIn = mk("input", "width:100%;box-sizing:border-box;border:1.5px solid #dfe5ec;border-radius:12px;padding:11px;font:600 14px system-ui;margin:8px 0 2px;color:#1A1A2E;background:#fff;display:none");
    nameIn.placeholder = L("اسم المجموعة السرّيّة", "Secret group name"); nameIn.maxLength = 80;
    var go = mkBtn("", "primary"); go.style.marginTop = "8px";
    function paint() {
      var n = Object.keys(picked).length;
      nameIn.style.display = n > 1 ? "" : "none";
      go.disabled = !n || (n > 1 && !nameIn.value.trim()); go.style.opacity = go.disabled ? ".5" : "1";
      go.textContent = n > 1 ? L("إنشاء مجموعة سرّيّة (" + n + ")", "Create secret group (" + n + ")") : L("بدء محادثة سرّيّة", "Start secret chat");
    }
    ppl.forEach(function (p) {
      var row = mk("label", "display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f1f4f7;font:600 14px system-ui;cursor:pointer");
      var cb = mk("input"); cb.type = "checkbox"; cb.style.cssText = "width:18px;height:18px";
      cb.onchange = function () { if (cb.checked) picked[p.uid] = 1; else delete picked[p.uid]; paint(); };
      row.appendChild(cb); row.appendChild(mk("span", "", displayName(p))); list.appendChild(row);
    });
    nameIn.oninput = paint;
    s.box.appendChild(list); s.box.appendChild(nameIn); s.box.appendChild(go); paint();
    go.onclick = function () {
      var ids = Object.keys(picked); if (!ids.length) return;
      go.disabled = true; go.textContent = "…";
      var p = ids.length === 1 ? e2eCreateDm(ids[0])
        : e2eCreateGroup(nameIn.value, ids);
      p.then(function () { s.close(); }).catch(function (e) { paint(); toast(e2eErrText(e)); });
    };
  }
  function e2eAct(cid) {
    var c = chats[cid]; if (!e2eOn(c)) return;
    var st = e2eState(c);
    if (st === "ready") return e2eSafety(cid);
    if (st !== "join" && st !== "other") { var u = e2eUi(c); if (u.text) toast(u.text); return; }
    if (!e2eNeedSupport()) return;
    var s = sheet(st === "other" ? L("نقل المحادثة السرّيّة إلى هذا الجهاز", "Move the secret chat here") : L("تفعيل المحادثة السرّيّة", "Turn on the secret chat"));
    e2eExplain(s.box);
    if (st === "other") s.box.appendChild(note(L("بعد النقل لا تصل الرسائل الجديدة إلى جهازك الآخر، ولا تنتقل الرسائل السابقة، ويرى الآخرون أنّ رمز الأمان تغيّر.",
      "New messages will stop reaching your other device, earlier messages won't move, and others will see your safety code changed."), "#b42318", "#fdecec"));
    var label = st === "other" ? L("نقلها إلى هذا الجهاز", "Move to this device") : L("تفعيل على هذا الجهاز", "Turn on for this device");
    var go = mkBtn(label, "primary"); go.style.marginTop = "8px";
    go.onclick = function () {
      go.disabled = true; go.textContent = "…";
      e2eJoin(cid)
        .then(function () { s.close(); toast(L("🔒 فُعّلت على هذا الجهاز", "🔒 Turned on for this device")); })
        .catch(function (e) { go.disabled = false; go.textContent = label; toast(e2eErrText(e)); });
    };
    s.box.appendChild(go);
  }
  function e2eSafety(cid) {
    var c = chats[cid]; if (!e2eOn(c)) return;
    var s = sheet(L("رمز الأمان", "Safety code"));
    s.box.appendChild(note(L("قارن هذه الأرقام مع الطرف الآخر وجهاً لوجه أو في مكالمة. إن تطابقت عندكما فلا أحد بينكما — ولا خادم سوا.",
      "Compare these numbers with the other person in person or on a call. If they match, nobody is in between — not even Sawa's server.")));
    var body = mk("div"); s.box.appendChild(body);
    e2e.myKey(false).then(function (me) {
      var e = c.e2e || {}, keys = e.keys || {}, devs = e.devs || {};
      if (!me || devs[state.uid] !== me.d) { body.appendChild(note(L("فعّل المحادثة على هذا الجهاز أوّلاً.", "Turn it on for this device first."))); return; }
      var os = others(c).filter(function (u) { var d = devs[u]; return d && keys[d] && keys[d].u === u; });
      if (!os.length) { body.appendChild(note(L("لم يفعّلها أحدٌ غيرك بعد.", "Nobody else has turned it on yet."))); return; }
      return Promise.all(os.map(function (u) { var k = keys[devs[u]].k; return Promise.all([e2e.safety(me.pub, k), e2e.devIdOf(k)]).then(function (x) { return { u: u, g: x[0], bad: x[1] !== devs[u] }; }); })).then(function (rows) {
        rows.forEach(function (r) {
          var card = mk("div", "border:1px solid #e6ebf0;border-radius:14px;padding:10px 12px;margin:8px 0");
          card.appendChild(mk("div", "font:800 13.5px system-ui;margin-bottom:8px", L("أنت و", "You and ") + personName(r.u, c)));
          if (r.bad) { card.appendChild(note(L("⚠️ مفتاح هذا الجهاز لا يطابق معرّفه — لا تثق بهذه المحادثة.", "⚠️ This device's key doesn't match its id — don't trust this chat."), "#b42318", "#fdecec")); body.appendChild(card); return; }
          var grid = mk("div", "display:grid;grid-template-columns:repeat(4,1fr);gap:6px 8px;direction:ltr;font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace;color:#14508c;text-align:center;letter-spacing:1px");
          r.g.forEach(function (x) { grid.appendChild(mk("div", "", x)); });
          card.appendChild(grid); body.appendChild(card);
        });
      });
    }).catch(function (e) { body.appendChild(note(e2eErrText(e), "#b42318", "#fdecec")); });
  }
  function e2eSampleOf(cid) {   // للبلاغ: آخر ٢٠ رسالة مفكوكة على هذا الجهاز
    return appMessages(cid).filter(function (o) { return o.type !== "system"; }).slice(-20).map(function (o) {
      return { by: realId(o.senderUserId || o.senderId || "") || null, text: String(o.text || "").slice(0, 300), ts: o.createdAt || 0 };
    });
  }

  global.SawaChat = {
    version: VERSION,
    bindApp: bindApp, refresh: refresh, contacts: contacts,
    shareInvite: shareInvite, createInvite: createInvite, renderQr: renderQr,
    accept: accept, scanSupported: scanSupported, scanAndAdd: scanAndAdd, removeContact: removeContact,
    me: function () { return state.me; }, uid: function () { return state.uid; },
    profile: profile, saveProfile: saveProfile, editProfile: editProfile,   // حسابي: الاسم والرقم
    renameContact: renameContact, nickOf: nickOf,
    qrLib: loadQrLib,   // C8: رمز QR لروابط الغرف
    isBlocked: function (u) { return !!(prefs && prefs.blocked && prefs.blocked.indexOf(u) >= 0); },   // C6: المحظور لا يرنّ
    status: function () { return { loaded: state.loaded, error: state.error, count: state.people.length }; },
    // C2
    isCloud: isCloud, enabled: function () { return !!state.uid; }, openChat: openChat, closeChat: closeChat,
    send: send, edit: edit, clearChat: clearChat,
    // C4
    enablePush: enablePush, disablePush: disablePush, pushEnabled: pushEnabled, pushSupported: pushSupported, pushState: pushState, pushHelp: helpSheet, pushCheckSheet: pushCheckSheet, updateSheet: updateSheet, checkUpdate: checkUpdate, forceUpdate: forceUpdate, updateAvailable: function () { return upd.available; },
    sendMedia: sendMedia, forwardMessage: forwardMessage, openFile: openFile, markViewedOnce: markViewedOnce, ensureMedia: ensureMedia,
    // C3
    createGroup: createGroup, updateGroup: updateGroup, addMembers: addMembers, removeMember: removeMember, setAdmin: setAdmin,
    leaveGroup: leaveGroup, shareGroupInvite: shareGroupInvite, joinGroup: joinGroup,
    sendPoll: sendPoll, vote: vote, editPoll: editPoll, sendBill: sendBill, billPaid: billPaid, sendFund: sendFund, contribute: contribute,
    sendTasks: sendTasks, setTask: setTask, deleteForAll: deleteForAll, deleteForMe: deleteForMe, react: react, pin: pin,
    setDisappear: setDisappear, openDm: openDm, openSaved: openSaved, dmWith: function (u) { return state.uid ? dmWith(u) : null; },
    typing: typing, whoTyping: whoTyping, observePrefs: observePrefs, markRead: markRead,
    _chats: function () { return chats; }, _days: function () { return days; }, _pend: function () { return pend; }, _flushMarks: flushMarks, _appMessages: appMessages,
    // C10
    codeSheet: codeSheet, findSheet: findSheet, verifySheet: verifySheet, requestsSheet: requestsSheet, emailSheet: emailSheet, linkSheet: linkSheet, loadRequests: loadRequests, deleteAccountSheet: deleteAccountSheet, reportSheet: reportSheet, sendVerify: sendVerify, emailVerified: function () { var u = emailUser(); return u ? !!u.emailVerified : null; },
    requestCount: function () { return reqs.incoming.length; }, fmtCode: fmtCode, codeValid: codeValid,
    retryFailed: retryFailed, discardFailed: discardFailed, failedSheet: failedSheet,   // C14
    retryMedia: retryMedia,   // C18
    scanAny: scanAny, routeScanned: routeScanned, signOutSheet: signOutSheet,   // C20
    e2eSupported: function () { return e2e.ok(); }, e2eStartDm: e2eStartDm, e2eNewSheet: e2eNewSheet, e2eAct: e2eAct, e2eSafety: e2eSafety,   // C23
    adminCached: adminCached, checkAdmin: checkAdmin,   // C24
    setBlocked: setBlocked,
    sendLocation: sendLocation, mapsUrl: mapsUrl,   // C32
    photoOf: photoOf, setMyPhoto: setMyPhoto,   // C25
    e2eCreateDm: e2eCreateDm, e2eCreateGroup: e2eCreateGroup, e2eJoin: e2eJoin, e2eState: function (cid) { return e2eState(chats[cid]); },
    _e2e: e2e, _plain: function () { return plain; },
    installState: installState, installable: installable, installSheet: installSheet, installNow: installNow,
    onboarding: function () { return onb ? onb.step : null; }, startOnboarding: function () { try { localStorage.removeItem("sawa_onboarded"); } catch (e) {} onbStart(); },
    _state: state, _onUid: onUid, _tokenFrom: tokenFrom
  };
  if (global.document && document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof window !== "undefined" ? window : this);
