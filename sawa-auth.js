/* ============================================================
   sawa-auth.js — طبقة الحسابات (المرحلة الأولى من السيرفر)
   ------------------------------------------------------------
   مصادقة الهاتف (OTP) + وثيقة الحساب accounts/{uid}.
   وحدةٌ مستقلّة تُحمَّل بجوار التطبيق — لا تمسّ sawa-app.js بعد.

   يعتمد على Firebase Compat SDK (يعرّف global `firebase`).
   حمّل قبل هذا الملف، في index.html، بالنسخة التي يعطيك إياها
   Firebase Console (Add app → Web). مثال:

     <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
     <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
     <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"></script>
     <script src="sawa-auth.js"></script>

   ⛔ لا يحتاج خطة Blaze: المصادقة وكتابة ملفّك الفرديّ على الخطة
   المجانية. Blaze يلزم لاحقاً للدوالّ (مزامنة العائلة).
   ============================================================ */
(function (global) {
  "use strict";

  // ⬇️ الصق هنا config مشروعك من Firebase Console (Add app → Web).
  // القيم عامّة غير سرّية (هكذا يصمّمها Firebase).
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBmnt6-HMdEaR7LinHWuUnnV26Xu5akkvE",
    authDomain: "sawa-test-9770f.firebaseapp.com",
    projectId: "sawa-test-9770f",
    storageBucket: "sawa-test-9770f.firebasestorage.app",
    messagingSenderId: "98971055474",
    appId: "1:98971055474:web:806f40756a2f4cdbdb19eb"
  };

  var app, auth, db, recaptcha, pendingConfirm = null;
  var userListeners = [];

  function ensureInit() {
    if (app) return;
    if (!global.firebase || !firebase.initializeApp) {
      throw new Error("Firebase SDK غير محمَّل — أضف وسوم gstatic قبل sawa-auth.js");
    }
    app  = firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();
    // تُبقي الجلسة عبر إعادة الفتح
    try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}
    // يبلّغ المستمعين بكلّ تغيّر في حالة الدخول
    auth.onAuthStateChanged(function (user) {
      if (user) { ensureAccountDoc(user); }
      userListeners.forEach(function (cb) { try { cb(user); } catch (e) {} });
    });
  }

  /* reCAPTCHA غير مرئيّ — تطلبه مصادقة الهاتف على الويب.
     containerId: معرّف عنصر div فارغ في الصفحة (مثلاً "recaptcha"). */
  function initRecaptcha(containerId) {
    ensureInit();
    if (recaptcha) return recaptcha;
    recaptcha = new firebase.auth.RecaptchaVerifier(containerId, {
      size: "invisible"
    });
    return recaptcha;
  }

  /* يبدأ الدخول: يرسل رمزاً إلى الرقم بالصيغة الدولية (+249…).
     يعيد Promise — نجاحه يعني أن الرمز أُرسل، فاطلب confirmCode. */
  function startPhoneSignIn(phoneE164, recaptchaContainerId) {
    ensureInit();
    var verifier = initRecaptcha(recaptchaContainerId || "recaptcha");
    return auth.signInWithPhoneNumber(phoneE164, verifier).then(function (confirm) {
      pendingConfirm = confirm;
      return true;
    });
  }

  /* يؤكّد الرمز الذي أدخله المستخدم. يعيد Promise<user>. */
  function confirmCode(code) {
    if (!pendingConfirm) return Promise.reject(new Error("لا طلب دخولٍ معلَّق"));
    return pendingConfirm.confirm(code).then(function (cred) {
      pendingConfirm = null;
      return cred.user;
    });
  }

  /* يُنشئ/يحدّث وثيقة الحساب — كتابةٌ يسمح بها قانون accounts/{uid}.
     لا يمسّ إلا الحقول المسموح بها في القواعد. */
  function ensureAccountDoc(user) {
    if (!db || !user) return Promise.resolve();
    var ref = db.collection("accounts").doc(user.uid);
    var now = firebase.firestore.FieldValue.serverTimestamp();
    return ref.get().then(function (snap) {
      if (snap.exists) {
        return ref.set({ phone: user.phoneNumber || null, updatedTs: now },
                       { merge: true });
      }
      return ref.set({
        displayName: user.displayName || null,
        phone: user.phoneNumber || null,
        locale: (global.navigator && navigator.language) || "ar",
        createdTs: now,
        updatedTs: now
      });
    }).catch(function (e) {
      // المزامنة أفضل جهد — لا نُسقِط الدخول إن فشلت كتابة الملفّ
      if (global.console) console.warn("ensureAccountDoc:", e && e.message);
    });
  }

  function onUser(cb) {
    ensureInit();
    userListeners.push(cb);
    // بلّغه بالحالة الحاليّة فوراً
    try { cb(auth.currentUser || null); } catch (e) {}
    return function off() {
      userListeners = userListeners.filter(function (f) { return f !== cb; });
    };
  }

  function currentUser() { ensureInit(); return auth.currentUser || null; }
  function signOut()     { ensureInit(); return auth.signOut(); }

  global.SawaAuth = {
    config: FIREBASE_CONFIG,     // للفحص فقط
    startPhoneSignIn: startPhoneSignIn,
    confirmCode: confirmCode,
    onUser: onUser,
    currentUser: currentUser,
    signOut: signOut
  };
})(typeof window !== "undefined" ? window : this);
