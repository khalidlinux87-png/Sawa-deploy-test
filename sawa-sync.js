/* ============================================================
   sawa-sync.js — طبقة الجسر بين التطبيق والخلفية (الـWorker + Firestore)
   ------------------------------------------------------------
   محلّيٌّ-أوّلاً: localStorage يبقى المخزن، والخادم مرجع للمجموعات المرفوعة.

   • connect()            — دخولٌ مجهول + accounts/{uid}                (B1)
   • observe(...)         — يُنادى من sawa-app.js عند كلّ تغيّر؛ يرسل الفرق
                            للمجموعات المرفوعة (ما عدا دور «مشاهد»)        (B4)
   • bindApp(setters)     — يُنادى مرّة من sawa-app.js ليطبّق الجسر بيانات
                            الخادم على حالة التطبيق                          (B5)
   • openPanel()          — لوحة «السحابة والمشاركة»: حساب Google، الرفع،
                            روابط المشاركة، استعادة العائلات                   (B5)
   • ?join=TOKEN          — رابط دعوة: ينضمّ ويستعيد العائلة تلقائياً         (B5)

   المجموعات: معرّفها المحلّيّ (g-1…) غير فريد عالمياً ⇒ يولّده الخادم، والربط
   في sawa_group_map {localGid: serverGid}، والأدوار في sawa_group_roles.
   الأشخاص والصلات: المعرّف المحلّيّ = معرّف الخادم (قرار §٨-١).

   الخصوصية: status_detail (ومنه «مريض») يُزامَن لأعضاء العائلة فقط (قرار خالد).
   photo و favorite و linkedTo تبقى محلّية؛ lastContactDate خاصٌّ بالمستخدم (contacts.sync).

   مفتاح الإيقاف: ?sync=off (و ?sync=on للإعادة). شارة الفحص: ?sync=debug.
   ============================================================ */
(function (global) {
  "use strict";

  var WORKER = "https://sawa-deploy-test.khalidlinux87.workers.dev";

  // مطابقةٌ تماماً لقائمة ALLOWED في الـWorker (v8+).
  // status_detail (مسافر/مغترب/متزوّج حديثاً/مريض) يُزامَن داخل العائلة — قرار خالد ٩ أكتوبر:
  // «مريض» يظهر لأهله ليطمئنّوا عليه. القراءة لأعضاء العائلة وحدهم (قواعد الأمان).
  // lastContactDate لا تُزامَن هنا: هي خاصّة بالمستخدم (contacts.sync أدناه).
  var SYNC_FIELDS = ["local_name", "gender", "kinship", "proximity", "birthYear", "birthday",
                     "alive", "death_date", "deathYear", "contacts", "phones", "notes", "motherId",
                     "status_detail", "noChildren"];


  var state = {
    uid: null, ready: false, error: null, isAnon: true, email: null,
    groupListeners: null, watching: null,
    reviews: 0, lastAck: "", sending: false
  };
  var readyResolvers = [];

  // ---------- أدوات ----------
  function log() {
    if (global.console && console.log) {
      try { console.log.apply(console, ["[sawa-sync]"].concat([].slice.call(arguments))); } catch (e) {}
    }
  }
  function lsGet(k, fb) { try { var r = localStorage.getItem(k); return r == null ? fb : JSON.parse(r); } catch (e) { return fb; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsRead(key, fb) { return lsGet("sawa:" + key, fb); } // مخازن التطبيق (البادئة sawa:)
  function isAr() { try { return (localStorage.getItem("sawaLang") || "ar") === "ar"; } catch (e) { return true; } }
  function L(ar, en) { return isAr() ? ar : en; }
  function clock() { var d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return (n < 10 ? "0" : "") + n; }).join(":"); }
  function hasFirebase() { return !!(global.firebase && firebase.auth && global.SawaAuth); }

  function enabled() {
    try {
      if (/[?&]sync=off/.test(global.location.search)) localStorage.setItem("sawa_sync_off", "1");
      if (/[?&]sync=on/.test(global.location.search)) localStorage.removeItem("sawa_sync_off");
      return localStorage.getItem("sawa_sync_off") !== "1";
    } catch (e) { return true; }
  }
  global.SAWA_SYNC = enabled();

  // ---------- B1: الاتصال ----------
  function setUser(user) {
    state.uid = user.uid; state.ready = true; state.error = null;
    state.isAnon = !!user.isAnonymous;
    state.email = user.email || (user.providerData && user.providerData[0] && user.providerData[0].email) || null;
  }
  function connect() {
    if (state.ready && state.uid) return Promise.resolve(state.uid);
    return new Promise(function (resolve) {
      try {
        if (!hasFirebase()) throw new Error("Firebase/SawaAuth غير محمَّل");
        SawaAuth.currentUser(); // يُهيّئ Firebase
        var auth = firebase.auth();
        // ⛔ لا دخول مجهول قبل أن يسترجع Firebase الجلسة المحفوظة: currentUser فارغٌ لحظة الإقلاع
        // حتّى لو كان المستخدم مسجّلاً بـGoogle، وطلب دخولٍ مجهول حينها يستبدل حسابه بهويّةٍ جديدة.
        // أوّل نداءٍ لـ onAuthStateChanged يأتي بعد اكتمال الاسترجاع — عندها فقط نقرّر.
        var firstAuth = true;
        auth.onAuthStateChanged(function (user) {
          if (firstAuth) {
            firstAuth = false;
            if (!user) {
              auth.signInAnonymously().catch(function (e) {
                state.error = (e && e.message) || "تعذّر الدخول المجهول";
                paintBadge(); resolve(null);
              });
              return;
            }
          }
          if (user) {
            var changed = state.uid && state.uid !== user.uid;
            setUser(user);
            paintBadge(); flushReady(user.uid); drain();
            if (changed) { rewatch(); }
            renderPanel();
          }
        });
        // نتيجة ربطٍ بإعادة التوجيه (بديل النافذة المنبثقة)
        handleRedirectResult();
        onReady(resolve);
      } catch (e) {
        state.error = (e && e.message) || String(e); state.ready = false;
        paintBadge(); log("connect فشل:", state.error); resolve(null);
      }
    });
  }
  function onReady(cb) {
    if (state.uid) { try { cb(state.uid); } catch (e) {} return; }
    readyResolvers.push(cb);
  }
  function flushReady(uid) {
    var l = readyResolvers; readyResolvers = [];
    l.forEach(function (cb) { try { cb(uid); } catch (e) {} });
  }
  function getToken() {
    try {
      var u = firebase.auth().currentUser;
      if (!u) return Promise.reject(new Error("لا مستخدم"));
      return u.getIdToken();
    } catch (e) { return Promise.reject(e); }
  }
  function sendWith(tok, op, payload) {
    return fetch(WORKER, {
      method: "POST",
      headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ op: op, payload: payload })
    }).then(function (r) { return r.json(); });
  }
  function sendOnce(op, payload) { return getToken().then(function (tok) { return sendWith(tok, op, payload); }); }
  function call(op, payload) { // كـsendOnce لكن يرمي عند الرفض
    return sendOnce(op, payload).then(function (b) {
      if (!b || b.ok === false) throw new Error((b && b.error) || (op + " failed"));
      return b;
    });
  }

  // ---------- صندوق الصادر: طابورٌ متسلسل محفوظ ----------
  var OUTBOX = "sawa_outbox", FAILED = "sawa_sync_failed";
  var retryTimer = null;
  function outboxLen() { return lsGet(OUTBOX, []).length; }
  function enqueue(op, payload) {
    var q = lsGet(OUTBOX, []); q.push({ op: op, payload: payload, ts: Date.now() }); lsSet(OUTBOX, q);
    paintBadge(); drain();
  }
  function push(op, payload) { if (!enabled()) return; enqueue(op, payload); }
  function drain() {
    if (state.sending || !state.uid || !enabled()) return;
    var q = lsGet(OUTBOX, []);
    if (!q.length) { applyPendingRemote(); return; }
    state.sending = true;
    var item = q[0];
    sendOnce(item.op, item.payload).then(function (b) {
      var rest = lsGet(OUTBOX, []); rest.shift(); lsSet(OUTBOX, rest);
      if (!b || b.ok === false) {
        var f = lsGet(FAILED, []); f.push({ op: item.op, error: b && b.error, ts: Date.now() });
        lsSet(FAILED, f.slice(-20));
        log("رُفض:", item.op, b && b.error);
        state.lastAck = "✗ " + item.op;
      } else {
        state.lastAck = "✓ " + item.op;
        if (b.queued) { state.reviews++; toast(L("تعديلٌ ذهب للمراجعة", "A change was sent for review")); }
      }
      state.sending = false; paintBadge(); drain();
    }).catch(function (e) {
      state.sending = false; state.lastAck = "… " + item.op + " (" + String((e && e.message) || e).slice(0, 40) + ")"; paintBadge();
      log("شبكة — إعادة لاحقاً:", (e && e.message) || e);
      if (!retryTimer) retryTimer = setTimeout(function () { retryTimer = null; drain(); }, 15000);
    });
  }
  try { global.addEventListener("online", drain); } catch (e) {}

  // ---------- ربط المجموعات والأدوار ----------
  function groupMap() { return lsGet("sawa_group_map", {}); }
  function serverGid(localGid) { return groupMap()[localGid] || null; }
  function localGidOf(sg) { var m = groupMap(); for (var k in m) if (m[k] === sg) return k; return null; }
  function setMap(localGid, sg) { var m = groupMap(); m[localGid] = sg; lsSet("sawa_group_map", m); }
  function roles() { return lsGet("sawa_group_roles", {}); }
  function roleOf(sg) { return roles()[sg] || "owner"; } // ما رُفع قبل v9 رفعه صاحبه
  function setRole(sg, role) { var r = roles(); r[sg] = role; lsSet("sawa_group_roles", r); }
  function mappedServerGids() { var m = groupMap(), out = []; for (var k in m) out.push(m[k]); return out; }

  // ---------- B4: المراقبة وحساب الفرق ----------
  function personToFields(p) {
    var out = {};
    for (var i = 0; i < SYNC_FIELDS.length; i++) {
      var k = SYNC_FIELDS[i];
      if (p && p[k] !== undefined) out[k] = p[k];
    }
    return out;
  }
  function snapshot(localGid, gp, rels) {
    var persons = {}, relations = {};
    ((gp && gp[localGid]) || []).forEach(function (p) { if (p && p.id) persons[p.id] = personToFields(p); });
    (rels || []).forEach(function (r) {
      if (r && r.id && r.groupId === localGid)
        relations[r.id] = { source: r.source, target: r.target, type: r.type, inferred: r.inferred || null };
    });
    return { persons: persons, relations: relations };
  }
  function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

  function diffAndEnqueue(sg, base, snap) {
    var id, k, n = 0;
    for (id in snap.persons) {
      var cur = snap.persons[id], old = base.persons[id];
      if (!old) { enqueue("person.set", { groupId: sg, personId: id, fields: cur }); n++; continue; }
      var changed = {}, any = false, keys = {};
      for (k in cur) keys[k] = 1;
      for (k in old) keys[k] = 1;
      for (k in keys) if (!same(cur[k], old[k])) { changed[k] = cur[k] === undefined ? null : cur[k]; any = true; }
      if (any) { enqueue("person.set", { groupId: sg, personId: id, fields: changed }); n++; }
    }
    for (id in snap.relations) {
      var r = snap.relations[id], b = base.relations[id];
      var addPayload = { groupId: sg, relationId: id, type: r.type, from: r.source, to: r.target };
      if (r.inferred) addPayload.inferred = r.inferred;
      if (!b) { enqueue("relation.add", addPayload); n++; continue; }
      if (b.source !== r.source || b.target !== r.target) {
        enqueue("relation.remove", { groupId: sg, relationId: id });
        enqueue("relation.add", addPayload); n++;
      } else if (b.type !== r.type) {
        enqueue("relation.update", { groupId: sg, relationId: id, type: r.type }); n++;
      }
    }
    for (id in base.relations) if (!snap.relations[id]) { enqueue("relation.remove", { groupId: sg, relationId: id }); n++; }
    for (id in base.persons) if (!snap.persons[id]) { enqueue("person.delete", { groupId: sg, personId: id }); n++; }
    return n;
  }

  var baseline = {};          // localGid -> لقطة آخر حالةٍ متّفقٍ عليها مع الخادم
  var applying = {};          // localGid -> true أثناء تطبيق بيانات الخادم (لا ترسل صداها)
  var lastGp = null, lastRels = null, lastCur = null, lastGroups = null, lastGroupsSig = null;
  var viewerWarned = {};
  function observe(gp, rels, currentGid, familyGroups) {
    lastGp = gp; lastRels = rels;
    if (familyGroups) {
      var sig = familyGroups.map(function (g) { return g && g.id; }).join("|");
      lastGroups = familyGroups;
      if (sig !== lastGroupsSig) { lastGroupsSig = sig; rewatch(); renderPanel(); }
    }
    if (currentGid !== undefined && currentGid !== lastCur) { lastCur = currentGid; rewatch(); renderPanel(); }
    if (!enabled()) return;
    var map = groupMap();
    for (var localGid in map) {
      if (!Object.prototype.hasOwnProperty.call(map, localGid)) continue;
      var snap = snapshot(localGid, gp, rels);
      var base = baseline[localGid];
      var wd = watchers[map[localGid]];
      if (wd && wd.err === "permission-denied" && base) continue;   // بلا صلاحيّة: نحتفظ بالتعديلات ولا نرسلها
      baseline[localGid] = snap;
      if (applying[localGid]) { applying[localGid] = false; continue; } // صدى الخادم
      if (!base) continue;      // أوّل مراقبة بعد الفتح = خطّ الأساس
      var sg = map[localGid];
      if (roleOf(sg) === "viewer") {
        if (JSON.stringify(base) !== JSON.stringify(snap) && !viewerWarned[sg]) {
          viewerWarned[sg] = true;
          toast(L("أنت مشاهد في هذه العائلة — تعديلاتك لا تُحفَظ على الخادم", "You're a viewer here — your edits aren't saved to the server"));
        }
        continue;
      }
      diffAndEnqueue(sg, base, snap);
    }
    for (var lg2 in map) if (watchers[map[lg2]] && contactsChanged(lg2, gp)) { scheduleContactSync(); break; }
  }

  // ---------- B5: ربط التطبيق + القراءة من الخادم ----------
  var app = null, appWaiters = [];
  function bindApp(api) {
    app = api;
    var w = appWaiters; appWaiters = [];
    w.forEach(function (cb) { try { cb(); } catch (e) {} });
    rewatch();
  }
  function whenApp(cb) { if (app) cb(); else appWaiters.push(cb); }
  // عائلات هذا الجهاز (من حالة التطبيق).
  function localGroupIds() {
    var ids = [];
    ((lastGroups || lsRead("familyGroups", [])) || []).forEach(function (g) { if (g && g.id) ids.push(g.id); });
    return ids;
  }
  // «العائلة المقصودة»: لا نعتمد على currentGroupId وحده — قد يكون فارغاً أو قديماً
  // (بعد حذف عائلة أو استيراد شجرة) بينما الشاشة تعرض عائلةً أخرى.
  function currentLocalGid() {
    var ids = localGroupIds(), cur = lastCur != null ? lastCur : lsRead("currentGroupId", "");
    if (cur && (ids.indexOf(cur) >= 0 || !ids.length)) return cur;
    var map = groupMap();
    for (var i = 0; i < ids.length; i++) if (map[ids[i]]) return ids[i];       // المربوطة أوّلاً
    var gp = lastGp || lsRead("groupPersons", {}), best = ids[0] || cur || "", bestN = -1;
    ids.forEach(function (id) { var n = (((gp || {})[id]) || []).length; if (n > bestN) { best = id; bestN = n; } });
    return best;                                                               // ثمّ الأكثر أشخاصاً
  }

  // مستمعٌ لكلّ عائلةٍ مربوطة على هذا الجهاز — التزامن لا يتوقّف على العائلة المفتوحة.
  var watchers = {}; // sg -> { sg, lg, uid, persons, relations, off, err, snap, note, contactsDone }
  function stopWatch(sg) { var w = watchers[sg]; if (!w) return; try { w.off && w.off(); } catch (e) {} delete watchers[sg]; }
  function restartWatch() { for (var sg in watchers) stopWatch(sg); rewatch(); }
  function rewatch() {
    if (!app || !state.uid || !enabled()) return;
    var map = groupMap(), ids = localGroupIds(), want = {};
    for (var lg in map) if (!ids.length || ids.indexOf(lg) >= 0) want[map[lg]] = lg;
    for (var sg in watchers) {
      var w = watchers[sg];
      if (!want[sg] || w.uid !== state.uid || w.lg !== want[sg]) stopWatch(sg);
    }
    for (var sg2 in want) if (!watchers[sg2]) startWatch(sg2, want[sg2]);
    paintBadge();
  }
  function startWatch(sg, lg) {
    var w = { sg: sg, lg: lg, uid: state.uid, persons: null, relations: null, off: null, err: null, snap: null, note: "waiting-snap", contactsDone: false };
    watchers[sg] = w;
    try {
      var base = firebase.firestore().collection("groups").doc(sg);
      var onErr = function (e) {
        w.err = (e && e.code) || "err"; w.note = "listen✗ " + w.err;
        log("القراءة مرفوضة:", sg, w.err); paintBadge();
      };
      var offP = base.collection("persons").onSnapshot(function (snap) {
        if (watchers[sg] !== w) return;
        var arr = []; snap.forEach(function (d) { arr.push(personFromDoc(d.id, d.data())); });
        w.persons = arr.filter(function (p) { return p.deleted !== true; });
        w.snap = state.lastSnap = clock(); w.err = null;
        applyPendingRemote();
      }, onErr);
      var offR = base.collection("relations").onSnapshot(function (snap) {
        if (watchers[sg] !== w) return;
        var arr = []; snap.forEach(function (d) { arr.push(relFromDoc(sg, d.id, d.data())); });
        w.relations = arr.filter(function (r) { return !r.deleted; });
        w.snap = state.lastSnap = clock(); w.err = null;
        applyPendingRemote();
      }, onErr);
      w.off = function () { try { offP(); } catch (e) {} try { offR(); } catch (e) {} };
    } catch (e) { w.err = "init"; w.note = "listen✗ init"; w.off = function () {}; }
  }
  function watcherFor(lg) { var sg = serverGid(lg); return sg ? watchers[sg] : null; }
  function mergePersons(localList, remoteList) {
    var byId = {}; (localList || []).forEach(function (p) { byId[p.id] = p; });
    var seen = {}, out = [];
    (localList || []).forEach(function (p) {
      var r = null;
      for (var i = 0; i < remoteList.length; i++) if (remoteList[i].id === p.id) { r = remoteList[i]; break; }
      if (!r) return; // حُذف في الخادم
      var m = {}; for (var k in p) m[k] = p[k];
      for (var j = 0; j < SYNC_FIELDS.length; j++) {
        var f = SYNC_FIELDS[j];
        if (!(f in r)) continue;
        m[f] = r[f];
      }
      out.push(m); seen[p.id] = 1;
    });
    remoteList.forEach(function (r) {
      if (seen[r.id]) return;
      var m = { id: r.id };
      for (var j = 0; j < SYNC_FIELDS.length; j++) { var f = SYNC_FIELDS[j]; if (f in r) m[f] = r[f]; }
      if (m.alive === undefined) m.alive = true;
      out.push(m);
    });
    return out;
  }
  function remoteRels(lg, list) {
    return list.map(function (r) {
      var o = { id: r.id, groupId: lg, source: r.source, target: r.target, type: r.type };
      if (r.inferred) o.inferred = r.inferred;
      return o;
    });
  }
  function applyPendingRemote() {
    if (!app) { state.applyNote = "noapp"; paintBadge(); return; }
    for (var sg in watchers) applyOne(watchers[sg]);
    paintBadge();
  }
  function applyOne(w) {
    if (w.err) { w.note = "listen✗ " + w.err; return; }
    if (!w.persons || !w.relations) { w.note = "waiting-snap"; return; }
    if (outboxLen() > 0 || state.sending) { w.note = "defer(Q)"; return; }   // تعديلاتنا أوّلاً
    var lg = w.lg;
    if (serverGid(lg) !== w.sg) { w.note = "gid≠"; return; }
    var gp = lastGp || {}, rels = lastRels || [];
    // تعديلاتٌ محلّية لم تُرسَل (مثلاً أُجريت أثناء فقدان الصلاحيّة): تُرسَل أوّلاً ثمّ نطابق الخادم
    var localSnap = snapshot(lg, gp, rels), base = baseline[lg];
    if (base && roleOf(w.sg) !== "viewer" && JSON.stringify(base) !== JSON.stringify(localSnap)) {
      baseline[lg] = localSnap;
      if (diffAndEnqueue(w.sg, base, localSnap) > 0) { w.note = "push-first"; return; }
    }
    var nextList = mergePersons(gp[lg] || [], w.persons);
    var nextRels = rels.filter(function (r) { return r.groupId !== lg; }).concat(remoteRels(lg, w.relations));
    var nextGp = {}; for (var k in gp) nextGp[k] = gp[k]; nextGp[lg] = nextList;
    var before = snapshot(lg, gp, rels), after = snapshot(lg, nextGp, nextRels);
    if (!w.contactsDone) { w.contactsDone = true; scheduleContactSync(800); }
    if (JSON.stringify(before) === JSON.stringify(after)) { w.note = "same"; return; }   // متطابقان
    applying[lg] = true;
    baseline[lg] = after;
    var persons = w.persons, relations = w.relations;
    app.setGroupPersons(function (prev) { var o = {}; for (var k in prev) o[k] = prev[k]; o[lg] = mergePersons(prev[lg] || [], persons); return o; });
    app.setKinshipRelations(function (prev) { return prev.filter(function (r) { return r.groupId !== lg; }).concat(remoteRels(lg, relations)); });
    lastGp = nextGp; lastRels = nextRels;
    w.note = "applied " + clock();
  }

  // ---------- «آخر تواصل» الخاصّ بالمستخدم بين أجهزته (contacts.sync) ----------
  // الدمج = الأحدث لكلّ شخص. لا يمرّ بالصادر: عمليّةٌ متكرّرة آمنة تُعاد عند كلّ مناسبة.
  var contactSent = {}, contactTimer = null, contactBusy = false;
  function localContacts(lg, gp) {
    var out = {};
    (((gp || {})[lg]) || []).forEach(function (p) { if (p && p.id && p.lastContactDate) out[p.id] = Number(p.lastContactDate); });
    return out;
  }
  function scheduleContactSync(delay) {
    if (contactTimer) clearTimeout(contactTimer);
    contactTimer = setTimeout(function () { contactTimer = null; contactSync(); }, delay == null ? 1500 : delay);
  }
  function contactSync() {
    if (!state.uid || !enabled() || contactBusy || !app) return;
    var lgs = []; for (var sg in watchers) lgs.push(watchers[sg].lg);
    if (!lgs.length) return;
    contactBusy = true;
    var total = 0;
    var next = function (i) {
      if (i >= lgs.length) {
        state.contactNote = "ct " + clock() + (total ? " +" + total : ""); paintBadge();
        contactBusy = false; return;
      }
      var lg = lgs[i], sg = serverGid(lg), mine = localContacts(lg, lastGp);
      if (!sg) return next(i + 1);
      call("contacts.sync", { groupId: sg, last: mine }).then(function (b) {
        var srv = b.last || {};
        contactSent[lg] = srv;
        var newer = {}, n = 0;
        for (var pid in srv) if (!mine[pid] || srv[pid] > mine[pid]) { newer[pid] = srv[pid]; n++; }
        if (n) {
          total += n;
          app.setGroupPersons(function (prev) {
            var o = {}; for (var k in prev) o[k] = prev[k];
            o[lg] = (prev[lg] || []).map(function (p) { return newer[p.id] ? Object.assign({}, p, { lastContactDate: newer[p.id] }) : p; });
            return o;
          });
        }
      }).catch(function (e) { state.contactNote = "ct✗"; log("contacts.sync:", (e && e.message) || e); })
        .then(function () { next(i + 1); });
    };
    next(0);
  }
  function contactsChanged(lg, gp) {
    var sent = contactSent[lg]; if (!sent) return false;
    var mine = localContacts(lg, gp);
    for (var pid in mine) if (!sent[pid] || mine[pid] > sent[pid]) return true;
    return false;
  }
  try {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { drain(); scheduleContactSync(300); }
    });
  } catch (e) {}

  // ---------- «ارفع شجرتي» ----------
  function buildImport(localGid, gp, rels) {
    var groups = lastGroups || lsRead("familyGroups", []);
    var gObj = (groups || []).filter(function (g) { return g && g.id === localGid; })[0];
    var persons = (gp && gp[localGid]) || [];
    var groupRels = (rels || []).filter(function (r) { return r && r.groupId === localGid; });
    return {
      persons: persons, groupRels: groupRels,
      payload: {
        name: (gObj && gObj.name) || "عائلتي",
        persons: persons.map(function (p) { var o = personToFields(p); o.localId = p.id; return o; }),
        relations: groupRels.map(function (r) {
          var o = { localId: r.id, fromLocalId: r.source, toLocalId: r.target, type: r.type };
          if (r.inferred) o.inferred = r.inferred;
          return o;
        })
      }
    };
  }
  function uploadGroup(localGid, gp, rels, opts) {
    var built = buildImport(localGid, gp, rels);
    if (opts && opts.groupId) { built.payload.groupId = opts.groupId; built.payload.replace = !!opts.replace; }
    return call("bulk.import", built.payload).then(function (b) {
      setMap(localGid, b.groupId); if (!b.existing) setRole(b.groupId, "owner");
      baseline[localGid] = snapshot(localGid, gp, rels);
      restartWatch();
      return b;
    });
  }
  // تطابق شجرتين = نسبة أشخاص الشجرة المحلّية الموجودين (غير محذوفين) في نسخة الخادم.
  // ممكنٌ لأنّ معرّفات الأشخاص ثابتة: الشجرة نفسها (تصديرٌ/استيراد أو جهازٌ آخر) لها المعرّفات نفسها.
  function overlap(localIds, serverIds) {
    if (!localIds.length) return 0;
    var set = {}; serverIds.forEach(function (id) { set[id] = 1; });
    var hit = 0; localIds.forEach(function (id) { if (set[id]) hit++; });
    return hit / localIds.length;
  }
  function serverPersonIds(sg) {
    return firebase.firestore().collection("groups").doc(sg).collection("persons").get().then(function (snap) {
      var ids = []; snap.forEach(function (d) { if (d.data().deleted !== true) ids.push(d.id); });
      return ids;
    });
  }
  function findDuplicate(localGid, gp) {
    var localIds = (((gp || {})[localGid]) || []).map(function (p) { return p.id; });
    return call("my.groups", {}).then(function (b) {
      var groups = (b.groups || []).filter(function (g) { return g.role === "owner" || g.role === "editor" || g.role === "viewer"; });
      return Promise.all(groups.map(function (g) {
        return serverPersonIds(g.groupId).then(function (ids) {
          return { sg: g.groupId, name: g.name, role: g.role, ratio: overlap(localIds, ids), serverCount: ids.length };
        }).catch(function () { return null; });
      }));
    }).then(function (list) {
      var best = null;
      (list || []).forEach(function (x) { if (x && (!best || x.ratio > best.ratio)) best = x; });
      return best && best.ratio >= 0.5 ? best : null;
    });
  }
  var pendingDup = null; // { localGid, sg, name, role, ratio, serverCount, localCount }
  function doUpload(localGid, gp, rels, opts) {
    toast(L("جارٍ الرفع…", "Uploading…"));
    return uploadGroup(localGid, gp, rels, opts).then(function (b) {
      var msg;
      if (b.replaced) msg = L("استُبدلت نسخة الخادم ✓ (" + b.personsImported + " شخصاً" + (b.removedPersons ? "، وأُزيل " + b.removedPersons : "") + ")",
                              "Server copy replaced ✓ (" + b.personsImported + " people" + (b.removedPersons ? ", " + b.removedPersons + " removed" : "") + ")");
      else msg = L("رُفعت شجرتك: " + b.personsImported + " شخصاً و" + b.relationsImported + " صلة ✓",
                   "Tree uploaded: " + b.personsImported + " people, " + b.relationsImported + " links ✓");
      toast(msg); paintBadge(); renderPanel(); refreshMyGroups();
      return b;
    }).catch(function (e) {
      toast(L("تعذّر الرفع: ", "Upload failed: ") + ((e && e.message) || e)); renderPanel();
      return null;
    });
  }
  function uploadCurrent() {
    var localGid = currentLocalGid();
    var gp = lastGp || lsRead("groupPersons", {});
    var rels = lastRels || lsRead("kinshipRelations", []);
    var n = ((gp && gp[localGid]) || []).length;
    if (!n) { toast(L("المجموعة الحالية لا تحوي أشخاصاً بعد", "This group has no people yet")); return Promise.resolve(null); }
    if (!state.uid) { toast(L("تعذّر الاتصال بالخادم — حاول بعد قليل", "Can't reach the server — try again shortly")); return Promise.resolve(null); }
    var sg = serverGid(localGid);
    if (sg) {
      // مربوطةٌ سلفاً: استبدالٌ في مكانها (تبقى المشاركة والأعضاء)
      if (roleOf(sg) !== "owner") { toast(L("استبدال الشجرة كلّها للمالك وحده", "Only the owner can replace the whole tree")); return Promise.resolve(null); }
      var ok = global.confirm(L("استبدال نسخة الخادم بشجرة هذا الجهاز؟ ما ليس على هذا الجهاز يُزال من الخادم. المشاركة والأعضاء يبقون كما هم.",
                                "Replace the server copy with this device's tree? Anything not on this device is removed from the server. Sharing stays as is."));
      if (!ok) return Promise.resolve(null);
      return doUpload(localGid, gp, rels, { groupId: sg, replace: true });
    }
    // غير مربوطة: هل الشجرة نفسها على حسابك سلفاً؟
    toast(L("أتحقّق إن كانت الشجرة مرفوعةً مسبقاً…", "Checking whether this tree is already uploaded…"));
    return findDuplicate(localGid, gp).then(function (dup) {
      if (!dup) return doUpload(localGid, gp, rels);
      pendingDup = { localGid: localGid, sg: dup.sg, name: dup.name, role: dup.role, ratio: dup.ratio,
                     serverCount: dup.serverCount, localCount: n };
      if (!panelEl || panelEl.style.display === "none") openPanel(); else renderPanel();
      return null;
    }).catch(function () { return doUpload(localGid, gp, rels); });
  }
  function resolveDup(choice) {
    var d = pendingDup; pendingDup = null;
    if (!d || choice === "cancel") { renderPanel(); return; }
    var gp = lastGp || lsRead("groupPersons", {}), rels = lastRels || lsRead("kinshipRelations", []);
    if (choice === "replace") {
      if (d.role !== "owner") { toast(L("استبدال الشجرة كلّها للمالك وحده", "Only the owner can replace the whole tree")); renderPanel(); return; }
      doUpload(d.localGid, gp, rels, { groupId: d.sg, replace: true });
    } else if (choice === "useServer") {
      // اربط هذه المجموعة بالنسخة الموجودة؛ الخادم مرجعٌ فتُطابَق الشجرة المحلّية معه
      setMap(d.localGid, d.sg); setRole(d.sg, d.role);
      baseline[d.localGid] = snapshot(d.localGid, gp, rels);
      restartWatch(); indexMine();
      toast(L("رُبطت بنسخة الخادم «" + d.name + "» ✓", "Linked to the server copy «" + d.name + "» ✓"));
      renderPanel();
    }
  }

  // ---------- B5: الهويّة — ربط حساب Google ----------
  function indexMine() {
    var ids = mappedServerGids();
    if (!ids.length || !state.uid) return Promise.resolve(null);
    return sendOnce("account.index", { groupIds: ids }).catch(function () { return null; });
  }
  function credFromError(e) {
    try {
      return e.credential || (firebase.auth.GoogleAuthProvider.credentialFromError && firebase.auth.GoogleAuthProvider.credentialFromError(e)) || null;
    } catch (x) { return null; }
  }
  function adoptFrom(oldTok) {
    return call("account.adopt", { fromToken: oldTok, groupIds: mappedServerGids() }).then(function (r) {
      (r.adopted || []).forEach(function (sg) { if (!roles()[sg]) setRole(sg, "owner"); });
      return r;
    });
  }
  function afterLinked(msg) {
    var u = firebase.auth().currentUser; if (u) setUser(u);
    restartWatch();
    return indexMine().then(function () { toast(msg); renderPanel(); refreshMyGroups(); });
  }
  function linkGoogle() {
    if (!hasFirebase() || !state.uid) { toast(L("تعذّر الاتصال بالخادم", "Can't reach the server")); return; }
    var auth = firebase.auth(), user = auth.currentUser;
    if (user && !user.isAnonymous) { toast(L("حسابك مربوطٌ سلفاً", "Already linked")); return; }
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    var oldTokP = user.getIdToken();
    // فهرس الهويّة الحالية أوّلاً (يلزم لتبنّيها إن احتجنا)
    indexMine();
    user.linkWithPopup(provider).then(function () {
      return afterLinked(L("رُبط حسابك بـGoogle ✓ — ادخل به من أيّ جهاز", "Linked to Google ✓ — sign in with it on any device"));
    }).catch(function (e) {
      var code = e && e.code;
      if (code === "auth/credential-already-in-use" || code === "auth/email-already-in-use") {
        // حساب Google مرتبطٌ بهويّةٍ أخرى سلفاً: ندخل بها ونتبنّى عضويّات هذا الجهاز
        var cred = credFromError(e);
        return oldTokP.then(function (oldTok) {
          var signIn = cred ? auth.signInWithCredential(cred) : auth.signInWithPopup(provider);
          return signIn.then(function () { return adoptFrom(oldTok); }).then(function () {
            return afterLinked(L("دخلتَ بحسابك على Google ✓ ونُقلت عائلات هذا الجهاز إليه", "Signed in with Google ✓ — this device's families moved to your account"));
          });
        }).catch(function (x) { toast(L("تعذّر الدخول: ", "Sign-in failed: ") + ((x && x.message) || x)); });
      }
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment" || code === "auth/cancelled-popup-request") {
        // بديل: إعادة التوجيه. نحفظ رمز الهويّة الحالية لتبنّيها بعد العودة.
        return oldTokP.then(function (oldTok) {
          try { sessionStorage.setItem("sawa_adopt_tok", oldTok); } catch (x) {}
          return user.linkWithRedirect(provider);
        });
      }
      if (code === "auth/popup-closed-by-user") return;
      toast(L("تعذّر الربط: ", "Linking failed: ") + ((e && (e.code || e.message)) || e));
    });
  }
  function handleRedirectResult() {
    try {
      var auth = firebase.auth();
      auth.getRedirectResult().then(function (res) {
        if (res && res.user) {
          try { sessionStorage.removeItem("sawa_adopt_tok"); } catch (x) {}
          onReady(function () { afterLinked(L("رُبط حسابك بـGoogle ✓", "Linked to Google ✓")); });
        }
      }).catch(function (e) {
        var code = e && e.code;
        if (code === "auth/credential-already-in-use" || code === "auth/email-already-in-use") {
          var cred = credFromError(e), oldTok = null;
          try { oldTok = sessionStorage.getItem("sawa_adopt_tok"); sessionStorage.removeItem("sawa_adopt_tok"); } catch (x) {}
          if (!cred) return;
          auth.signInWithCredential(cred).then(function () { return oldTok ? adoptFrom(oldTok) : null; })
            .then(function () { afterLinked(L("دخلتَ بحسابك على Google ✓", "Signed in with Google ✓")); })
            .catch(function (x) { toast(L("تعذّر الدخول: ", "Sign-in failed: ") + ((x && x.message) || x)); });
        }
      });
    } catch (e) {}
  }

  // ---------- B5: المشاركة والانضمام والاستعادة ----------
  function shareLink(role) {
    var lg = currentLocalGid(), sg = serverGid(lg);
    if (!sg) { toast(L("ارفع الشجرة أوّلاً", "Upload the tree first")); return; }
    toast(L("جارٍ إنشاء الرابط…", "Creating link…"));
    call("invite.create", { groupId: sg, role: role }).then(function (b) {
      var url = global.location.origin + global.location.pathname + "?join=" + b.token;
      var gname = groupName(lg);
      var text = role === "editor"
        ? L("رابط تحرير شجرة «" + gname + "» في سوا (صالح أسبوعاً):", "Edit link for the «" + gname + "» tree on Sawa (valid 1 week):")
        : L("انضمّ لمشاهدة شجرة «" + gname + "» في سوا (صالح أسبوعاً):", "Join to view the «" + gname + "» tree on Sawa (valid 1 week):");
      if (global.navigator && navigator.share) {
        navigator.share({ title: "سوا", text: text, url: url }).catch(function () {});
      } else if (global.navigator && navigator.clipboard) {
        navigator.clipboard.writeText(text + " " + url).then(function () { toast(L("نُسخ الرابط ✓", "Link copied ✓")); },
          function () { global.prompt(L("انسخ الرابط:", "Copy the link:"), url); });
      } else {
        global.prompt(L("انسخ الرابط:", "Copy the link:"), url);
      }
    }).catch(function (e) {
      var m = (e && e.message) || String(e);
      if (/not a manager|only the owner can invite/.test(m)) m = L("هذا الحساب ليس مالك العائلة على الخادم — سجّل الدخول بحساب Google الذي رفعها.", "This account isn't the family's owner on the server — sign in with the Google account that uploaded it.");
      toast(L("تعذّر إنشاء الرابط: ", "Couldn't create link: ") + m);
    });
  }
  function restoreGroup(sg, name, role) {
    var existing = localGidOf(sg);
    setRole(sg, role || "viewer");
    if (existing) { app.setCurrentGroupId(existing); return Promise.resolve(existing); }
    // إن كانت العائلة المفتوحة غير مربوطة وفارغةً أو هي الشجرة نفسها: نربطها بدل إنشاء عائلةٍ ثانية بالاسم نفسه
    var cur = currentLocalGid(), gp = lastGp || lsRead("groupPersons", {}), rels = lastRels || lsRead("kinshipRelations", []);
    var curIds = (((gp || {})[cur]) || []).map(function (p) { return p.id; });
    if (cur && !serverGid(cur)) {
      return serverPersonIds(sg).then(function (ids) {
        if (!curIds.length || overlap(curIds, ids) >= 0.5) {
          setMap(cur, sg);
          baseline[cur] = snapshot(cur, gp, rels);     // الخادم مرجع: تُطابَق المحلّية معه
          restartWatch();
          return cur;
        }
        return createRestored(sg, name, role);
      }).catch(function () { return createRestored(sg, name, role); });
    }
    return Promise.resolve(createRestored(sg, name, role));
  }
  function createRestored(sg, name, role) {
    var lg = "g-" + Date.now();
    setMap(lg, sg);
    baseline[lg] = { persons: {}, relations: {} };
    app.setFamilyGroups(function (prev) { return (prev || []).concat([{ id: lg, name: name || "عائلتي", description: "", role: role || "viewer" }]); });
    app.setGroupPersons(function (prev) { var o = {}; for (var k in prev) o[k] = prev[k]; o[lg] = []; return o; });
    if (app.setGroupSettings) app.setGroupSettings(function (prev) { var o = {}; for (var k in prev) o[k] = prev[k]; o[lg] = { allowMemberEvents: false }; return o; });
    app.setCurrentGroupId(lg);
    return lg;
  }

  function roleLabel(role) {
    return role === "owner" ? L("مالك", "owner") : role === "editor" ? L("محرّر", "editor") : L("مشاهد", "viewer");
  }
  function handleJoin() {
    var tok = null;
    try { tok = new URLSearchParams(global.location.search).get("join"); } catch (e) {}
    if (!tok) return;
    onReady(function () {
      whenApp(function () {
        call("invite.accept", { token: tok }).then(function (b) {
          restoreGroup(b.groupId, b.name, b.role);
          toast(L("انضممتَ إلى «" + (b.name || "العائلة") + "» (" + roleLabel(b.role) + ") ✓",
                  "Joined «" + (b.name || "family") + "» (" + roleLabel(b.role) + ") ✓"));
        }).catch(function (e) {
          var m = (e && e.message) || "";
          toast(/expired/.test(m) ? L("انتهت صلاحيّة رابط الدعوة", "This invite link has expired")
                                  : L("تعذّر الانضمام: ", "Couldn't join: ") + m);
        }).then(function () {
          try { var u = new URL(global.location.href); u.searchParams.delete("join"); global.history.replaceState(null, "", u.toString()); } catch (e) {}
        });
      });
    });
  }
  var myGroups = null, myGroupsLoading = false;
  function refreshMyGroups() {
    if (!state.uid || myGroupsLoading) return;
    myGroupsLoading = true; renderPanel();
    call("my.groups", {}).then(function (b) {
      myGroups = b.groups || [];
      myGroups.forEach(function (g) { if (localGidOf(g.groupId)) setRole(g.groupId, g.role); });
    }).catch(function () { myGroups = myGroups || []; })
      .then(function () { myGroupsLoading = false; renderPanel(); });
  }
  function unmap(sg) {
    var m = groupMap(), changed = false;
    for (var k in m) if (m[k] === sg) { delete m[k]; delete baseline[k]; changed = true; }
    if (changed) lsSet("sawa_group_map", m);
    var r = roles(); delete r[sg]; lsSet("sawa_group_roles", r);
    stopWatch(sg); rewatch();
  }
  function fmtNum(n) { try { return Number(n || 0).toLocaleString(isAr() ? "ar-EG" : "en-US"); } catch (e) { return String(n); } }
  function fmtWhen(ts) {
    if (!ts) return "";
    try { return new Date(ts).toLocaleString(isAr() ? "ar-EG" : "en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
    catch (e) { return ""; }
  }
  function deleteGroup(sg) {
    var g = (myGroups || []).filter(function (x) { return x.groupId === sg; })[0] || { name: "", personCount: 0 };
    var ok = global.confirm(L(
      "حذف «" + g.name + "» (" + fmtNum(g.personCount) + " شخصاً، أُنشئت " + fmtWhen(g.createdTs) + ") من الخادم؟\n" +
      "يفقد كلّ من شاركتها معهم الوصول إليها، وتتوقّف روابط دعوتها. نسخ الأجهزة المحلّية لا تُحذف.",
      "Delete «" + g.name + "» (" + g.personCount + " people, created " + fmtWhen(g.createdTs) + ") from the server?\n" +
      "Everyone you shared it with loses access and its invite links stop working. Local copies on devices stay."));
    if (!ok) return;
    call("group.delete", { groupId: sg }).then(function () {
      unmap(sg);
      toast(L("حُذفت العائلة من الخادم ✓", "Family deleted from the server ✓"));
      refreshMyGroups(); renderPanel();
    }).catch(function (e) { toast(L("تعذّر الحذف: ", "Couldn't delete: ") + ((e && e.message) || e)); });
  }
  function leaveGroup(sg) {
    var g = (myGroups || []).filter(function (x) { return x.groupId === sg; })[0] || { name: "" };
    if (!global.confirm(L("مغادرة «" + g.name + "»؟ لن تصلك تحديثاتها بعد الآن.", "Leave «" + g.name + "»? You'll stop receiving its updates."))) return;
    call("group.leave", { groupId: sg }).then(function () {
      unmap(sg); toast(L("غادرتَ العائلة ✓", "You left the family ✓")); refreshMyGroups(); renderPanel();
    }).catch(function (e) { toast(L("تعذّر: ", "Failed: ") + ((e && e.message) || e)); });
  }
  function groupName(lg) {
    var groups = lastGroups || lsRead("familyGroups", []);
    var g = (groups || []).filter(function (x) { return x && x.id === lg; })[0];
    return (g && g.name) || L("عائلتي", "My family");
  }

  // ---------- B5: لوحة «السحابة والمشاركة» ----------
  var panelEl = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function openPanel() {
    if (!panelEl) {
      panelEl = document.createElement("div");
      panelEl.id = "sawa-cloud-panel";
      panelEl.addEventListener("click", function (ev) {
        var t = ev.target.closest ? ev.target.closest("[data-act]") : null;
        if (ev.target === panelEl) { closePanel(); return; }
        if (!t) return;
        var act = t.getAttribute("data-act");
        if (act === "close") closePanel();
        else if (act === "google") linkGoogle();
        else if (act === "upload") uploadCurrent();
        else if (act === "dup-replace") resolveDup("replace");
        else if (act === "dup-server") resolveDup("useServer");
        else if (act === "dup-cancel") resolveDup("cancel");
        else if (act === "delete") deleteGroup(t.getAttribute("data-gid"));
        else if (act === "relink-new") {
          var cg = currentLocalGid(), csg = serverGid(cg);
          if (csg && global.confirm(L("فكّ ربط هذه العائلة بنسختها القديمة ورفعها كعائلةٍ جديدة على الحساب الحاليّ؟",
                                      "Unlink this family from its old copy and upload it as a new family on the current account?"))) {
            unmap(csg); uploadCurrent();
          }
        }
        else if (act === "leave") leaveGroup(t.getAttribute("data-gid"));
        else if (act === "share-viewer") shareLink("viewer");
        else if (act === "share-editor") shareLink("editor");
        else if (act === "restore") {
          var sg = t.getAttribute("data-gid");
          var g = (myGroups || []).filter(function (x) { return x.groupId === sg; })[0];
          if (g && app) { restoreGroup(g.groupId, g.name, g.role); toast(L("جارٍ استعادة «" + g.name + "»…", "Restoring «" + g.name + "»…")); closePanel(); }
        }
      });
      document.body.appendChild(panelEl);
    }
    panelEl.style.display = "flex";
    renderPanel();
    refreshMyGroups();
  }
  function closePanel() { if (panelEl) panelEl.style.display = "none"; }
  function renderPanel() {
    if (!panelEl || panelEl.style.display === "none") return;
    var ar = isAr(), dir = ar ? "rtl" : "ltr";
    var lg = currentLocalGid(), sg = serverGid(lg), role = sg ? roleOf(sg) : null;
    var btn = function (act, label, primary, extra) {
      return '<button data-act="' + act + '"' + (extra || "") + ' style="display:block;width:100%;margin:8px 0 0;padding:12px 14px;border-radius:12px;font:700 15px system-ui;cursor:pointer;' +
        (primary ? 'background:#187854;color:#fff;border:none;' : 'background:#fff;color:#1E3A63;border:1.5px solid #cfdbe8;') + '">' + label + '</button>';
    };
    var sec = function (title, body) {
      return '<div style="background:#f5f8fb;border-radius:14px;padding:14px;margin-top:12px"><div style="font:800 13px system-ui;color:#5b6b7c;margin-bottom:6px">' + title + '</div>' + body + '</div>';
    };
    var p = function (txt, color) { return '<div style="font:500 14px/1.6 system-ui;color:' + (color || "#1f2d3a") + '">' + txt + '</div>'; };

    var acct;
    if (!state.uid) acct = p(L("جارٍ الاتصال بالخادم…", "Connecting…"), "#8a6d1f");
    else if (state.isAnon) acct = p(L("ضيف — هويّتك محفوظة في هذا المتصفّح فقط. اربطها بحساب Google لتصل لعائلتك من أيّ جهاز ولا تضيع عند مسح المتصفّح.",
                                       "Guest — your identity lives in this browser only. Link Google to reach your family from any device.")) +
                               btn("google", L("ربط بحساب Google", "Link Google account"), true);
    else acct = p("✓ " + esc(state.email || L("حساب Google", "Google account")), "#187854");

    var fam = '<div style="font:800 16px system-ui;color:#1f2d3a">' + esc(groupName(lg)) + '</div>';
    if (pendingDup && pendingDup.localGid === lg) {
      var pct = Math.round(pendingDup.ratio * 100);
      fam += p(L("هذه الشجرة مرفوعةٌ مسبقاً على حسابك باسم «" + esc(pendingDup.name) + "» (تطابق " + pct + "٪ — على الخادم " + pendingDup.serverCount + " شخصاً، وعلى هذا الجهاز " + pendingDup.localCount + ").",
                 "This tree is already on your account as «" + esc(pendingDup.name) + "» (" + pct + "% match — " + pendingDup.serverCount + " on server, " + pendingDup.localCount + " here)."), "#8a5a00") +
             (pendingDup.role === "owner" ? btn("dup-replace", L("استبدال نسخة الخادم بشجرة هذا الجهاز", "Replace the server copy with this device's tree"), true) : "") +
             btn("dup-server", L("استخدام نسخة الخادم (تحلّ محلّ شجرة هذا الجهاز)", "Use the server copy (replaces this device's tree)")) +
             btn("dup-cancel", L("إلغاء", "Cancel"));
    } else if (sg && watchers[sg] && watchers[sg].err === "permission-denied") {
      fam += p(L("⚠ هذه العائلة رُفعت بحسابٍ غير المسجَّل الآن، فالخادم يرفض الوصول إليها. تعديلاتك هنا محفوظةٌ على الجهاز وتُرسَل حين تعود الصلاحيّة.",
                 "⚠ This family was uploaded by a different account than the one signed in now, so the server refuses access. Your edits here are kept on this device and sent once access is back."), "#8a5a00");
      if (state.isAnon) fam += p(L("سجّل الدخول بحساب Google الذي رفعها لتستعيد الوصول:", "Sign in with the Google account that uploaded it to regain access:")) +
                               btn("google", L("الدخول بحساب Google", "Sign in with Google"), true);
      fam += btn("relink-new", L("أو: ارفعها كعائلةٍ جديدة على هذا الحساب", "Or: upload it as a new family on this account"));
    } else if (!sg) {
      fam += p(L("محفوظة على هذا الجهاز فقط — غير مربوطة بالخادم، فلا تتزامن.", "Saved on this device only — not linked, so it doesn't sync."));
      if (myGroups && myGroups.some(function (g) { return !localGidOf(g.groupId); }))
        fam += p(L("على حسابك عائلاتٌ محفوظة أدناه: إن كانت هذه الشجرة منها فاضغط «استعادة» بدل الرفع.",
                   "Your account has families below — if this tree is one of them, tap «Restore» instead of uploading."), "#8a5a00");
      fam += btn("upload", L("ارفع شجرتي إلى السحابة", "Upload my tree"), true);
    }
    else {
      fam += p(L("متزامنة مع السحابة ✓ · دورك: ", "Synced ✓ · your role: ") + roleLabel(role), "#187854");
      if (role === "owner" || role === "editor") fam += btn("share-viewer", L("مشاركة للمشاهدة (رابط)", "Share view-only link"));
      if (role === "owner") fam += btn("share-editor", L("رابط تحرير (لأجهزتك أو من تثق به)", "Edit link (your devices / trusted)"));
      if (role === "owner") fam += btn("upload", L("استبدال نسخة الخادم بشجرة هذا الجهاز", "Replace the server copy with this device's tree"));
    }

    var mine;
    if (myGroupsLoading && !myGroups) mine = p(L("جارٍ التحميل…", "Loading…"), "#5b6b7c");
    else {
      var all = myGroups || [];
      if (!all.length) mine = p(L("لا عائلات على حسابك بعد.", "No families on your account yet."), "#5b6b7c");
      else mine = all.map(function (g) {
        var here = localGidOf(g.groupId), isCur = here && here === lg;
        var meta = roleLabel(g.role) + " · " + fmtNum(g.personCount) + L(" شخصاً", " people") + (g.createdTs ? " · " + fmtWhen(g.createdTs) : "");
        var tag = here ? '<div style="font:700 12px system-ui;color:#187854;margin-top:2px">' + (isCur ? L("مربوطة · المفتوحة الآن ✓", "Linked · open now ✓") : L("مربوطة بهذا الجهاز ✓", "Linked on this device ✓")) + '</div>' : "";
        var smallBtn = function (act, label, bg, fg, border) {
          return '<button data-act="' + act + '" data-gid="' + esc(g.groupId) + '" style="padding:8px 12px;border-radius:10px;border:' + (border || "none") + ';background:' + bg + ';color:' + fg + ';font:700 13px system-ui">' + label + '</button>';
        };
        var actions = (!here ? smallBtn("restore", L("استعادة", "Restore"), "#2F80C8", "#fff") : "") +
                      (g.role === "owner" ? smallBtn("delete", L("حذف", "Delete"), "#fff", "#b23b3b", "1.5px solid #e6b4b4")
                                          : smallBtn("leave", L("مغادرة", "Leave"), "#fff", "#5b6b7c", "1.5px solid #cfdbe8"));
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;border-top:1px solid #e3eaf1">' +
          '<div><div style="font:700 15px system-ui">' + esc(g.name) + '</div>' +
          '<div style="font:500 12.5px system-ui;color:#5b6b7c;margin-top:2px">' + esc(meta) + '</div>' + tag + '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0">' + actions + '</div></div>';
      }).join("");
    }

    panelEl.setAttribute("dir", dir);
    panelEl.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:rgba(10,20,30,.45);display:flex;align-items:flex-end;justify-content:center";
    panelEl.innerHTML =
      '<div style="background:#fff;width:100%;max-width:520px;max-height:88vh;overflow:auto;border-radius:20px 20px 0 0;padding:18px 16px 24px;box-shadow:0 -6px 24px rgba(0,0,0,.2)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between">' +
          '<div style="font:800 19px system-ui;color:#1f2d3a">' + L("السحابة والمشاركة", "Cloud & sharing") + '</div>' +
          '<button data-act="close" aria-label="close" style="border:none;background:#eef2f6;border-radius:50%;width:34px;height:34px;font:700 18px system-ui;cursor:pointer">×</button>' +
        '</div>' +
        sec(L("حسابك", "Your account"), acct) +
        sec(L("هذه العائلة", "This family"), fam) +
        sec(L("عائلات على حسابك", "Families on your account"), mine) +
      '</div>';
  }

  // ---------- القراءة الحيّة ----------
  function rawWatch(gid, cbs) {
    if (!gid) return function () {};
    if (state.groupListeners && state.groupListeners.off) { try { state.groupListeners.off(); } catch (e) {} }
    try {
      var base = firebase.firestore().collection("groups").doc(gid);
      var onErr = function (e) { log("مستمع:", (e && e.message) || e); if (cbs && cbs.onError) cbs.onError(e); };
      var offP = base.collection("persons").onSnapshot(function (snap) {
        var arr = []; snap.forEach(function (d) { arr.push(personFromDoc(d.id, d.data())); });
        cbs && cbs.onPersons && cbs.onPersons(arr);
      }, onErr);
      var offR = base.collection("relations").onSnapshot(function (snap) {
        var arr = []; snap.forEach(function (d) { arr.push(relFromDoc(gid, d.id, d.data())); });
        cbs && cbs.onRelations && cbs.onRelations(arr);
      }, onErr);
      var off = function () { try { offP(); } catch (e) {} try { offR(); } catch (e) {} };
      state.groupListeners = { gid: gid, off: off };
      return off;
    } catch (e) { log("rawWatch فشل:", (e && e.message) || e); return function () {}; }
  }
  function watchGroup(gid, cbs) { if (!enabled()) return function () {}; return rawWatch(gid, cbs); }
  function personFromDoc(id, data) {
    var p = { id: id };
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      if (k === "fts" || k === "healthStatus") continue;
      p[k] = data[k];
    }
    return p;
  }
  function relFromDoc(gid, id, data) {
    return { id: id, groupId: gid, source: data.from, target: data.to, type: data.type,
             inferred: data.inferred, deleted: data.deleted === true };
  }
  function relToServer(r) { return { groupId: r.groupId, type: r.type, from: r.source, to: r.target }; }

  // ---------- إشعارٌ صغير ----------
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483646;" +
          "background:rgba(20,30,40,.92);color:#fff;font:600 14px system-ui;padding:10px 16px;border-radius:12px;" +
          "max-width:86vw;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.3);transition:opacity .25s;pointer-events:none";
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg; toastEl.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, 3800);
    } catch (e) {}
  }

  // ---------- شارة الفحص ----------
  function debugOn() {
    try {
      if (/[?&]sync=(debug|seed|upload)/.test(global.location.search)) localStorage.setItem("sawa_sync_debug", "1");
      if (/[?&]sync=nodebug/.test(global.location.search)) localStorage.removeItem("sawa_sync_debug");
      return localStorage.getItem("sawa_sync_debug") === "1";
    } catch (e) { return false; }
  }
  var badgeEl = null;
  function paintBadge() {
    if (!debugOn()) return;
    try {
      if (!badgeEl) {
        badgeEl = document.createElement("div");
        badgeEl.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;" +
          "font:700 13px system-ui;padding:9px 12px;border-radius:10px;text-align:center;" +
          "box-shadow:0 2px 10px rgba(0,0,0,.35);direction:ltr;pointer-events:none;";
        document.body.appendChild(badgeEl);
      }
      var ok = state.ready && state.uid;
      badgeEl.style.background = ok ? "#187854" : (state.error ? "#b23b3b" : "#8a6d1f");
      badgeEl.style.color = "#fff";
      var body = ok ? ((state.isAnon ? "anon " : "G✓ ") + String(state.uid).slice(0, 6) + "…") : (state.error ? ("err: " + state.error) : "connecting…");
      var cw = watcherFor(currentLocalGid());
      if (cw) { state.dbgGid = cw.sg; state.dbgPersons = cw.persons ? cw.persons.length : null; state.dbgRelations = cw.relations ? cw.relations.length : null; }
      if (state.dbgGid) {
        body += " · G " + String(state.dbgGid).slice(0, 6) +
                " P:" + (state.dbgPersons == null ? "?" : state.dbgPersons) +
                " R:" + (state.dbgRelations == null ? "?" : state.dbgRelations);
      }
      var fl = lsGet(FAILED, []);
      body += " · Q:" + outboxLen() + " F:" + fl.length + " Rv:" + state.reviews;
      if (state.lastAck) body += " " + state.lastAck;
      if (fl.length) body += " [" + fl[fl.length - 1].op + ": " + String(fl[fl.length - 1].error || "").slice(0, 60) + "]";
      var nW = 0; for (var k2 in watchers) nW++;
      var note = cw ? cw.note : (app ? (serverGid(currentLocalGid()) ? (state.uid ? "waiting-snap" : "no-auth") : "unlinked") : "noapp");
      body += " · W:" + nW + " · snap " + ((cw && cw.snap) || "–") + " · " + note;
      if (state.contactNote) body += " · " + state.contactNote;
      var cl = currentLocalGid(), csg = serverGid(cl);
      body += " · L " + String(cl).slice(-6) + "→" + (csg ? String(csg).slice(0, 6) : "∅");
      if (state.dbgNote) body = state.dbgNote + " · " + body;
      badgeEl.textContent = "sync " + (enabled() ? "ON" : "off") + " · " + body;
    } catch (e) {}
  }
  function debugParam(name) { try { return new URLSearchParams(global.location.search).get(name); } catch (e) { return null; } }
  function debugRun() {
    if (!debugOn()) return;
    var mode = debugParam("sync"), gid = debugParam("gid");
    if (!gid || mode === "upload") return; // الشارة تقرأ أرقام مستمع التطبيق نفسه
    onReady(function () {
      state.dbgGid = gid;
      rawWatch(gid, {
        onPersons:   function (arr) { state.dbgPersons   = arr.filter(function (p) { return p.deleted !== true; }).length; paintBadge(); },
        onRelations: function (arr) { state.dbgRelations = arr.filter(function (r) { return !r.deleted; }).length; paintBadge(); }
      });
    });
  }

  // ---------- الواجهة العامّة ----------
  global.SawaSync = {
    connect: connect, onReady: onReady, getToken: getToken,
    push: push, observe: observe, bindApp: bindApp,
    uploadCurrent: uploadCurrent, openPanel: openPanel, linkGoogle: linkGoogle, shareLink: shareLink,
    watchGroup: watchGroup, serverGid: serverGid,
    personToFields: personToFields, relToServer: relToServer,
    uid: function () { return state.uid; },
    isReady: function () { return !!(state.ready && state.uid); },
    _state: state, _diff: diffAndEnqueue, _snapshot: snapshot, _merge: mergePersons, _overlap: overlap,
    _testDenied: function (sg, lg) { watchers[sg] = { sg: sg, lg: lg, uid: state.uid, persons: null, relations: null, off: function () {}, err: "permission-denied", contactsDone: true }; },
    _restore: function (sg, name, role) { return restoreGroup(sg, name, role); },
    _testPanel: function (groups) { myGroups = groups; myGroupsLoading = false; openPanel(); myGroups = groups; myGroupsLoading = false; renderPanel(); return panelEl.innerHTML; },
    _testRemote: function (lg, sg, persons, relations) { watchers[sg] = { sg: sg, lg: lg, uid: state.uid, persons: persons, relations: relations, off: function () {}, contactsDone: true }; applyPendingRemote(); },
    _current: function () { return currentLocalGid(); }
  };

  // ---------- إقلاعٌ ذاتيّ ----------
  var indexedOnce = false;
  function boot() {
    paintBadge();
    handleJoin();
    connect().then(function (uid) {
      paintBadge();
      log(uid ? ("متّصل: " + uid) : "تعذّر الاتصال — التطبيق يعمل محلّياً");
      if (uid && !indexedOnce) { indexedOnce = true; indexMine(); }
      rewatch();
      debugRun();
    });
  }
  if (global.document && document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof window !== "undefined" ? window : this);
