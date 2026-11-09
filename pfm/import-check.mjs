// Browser check of receipt import (IMPORT-DESIGN.md §4.7): the real app files (joined parts and /ocr/v1 reader),
// the real Worker op code (Node side) and an in-memory Firestore. The screenshots are INVENTED: Bankak-style screens
// drawn in the browser with made-up names, accounts and numbers (real samples live only in the private repository).
// Usage: node pfm/import-check.mjs <path to Sawa-app> <dir with node_modules/react@18.3.1 and react-dom@18.3.1> <screenshot dir>
import { createRequire } from "module";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const require = createRequire(path.join(path.resolve(process.argv[3] || "."), "x.js"));
const { chromium } = require("playwright");
const { handlePfmOp } = await import("./pfm-worker.mjs");
const { makeFs, ROOT } = await import("./fake-firestore.mjs");

const APP = path.resolve(process.argv[2] || "../Sawa-app"), NM = path.resolve(process.argv[3] || "."), OUT = path.resolve(process.argv[4] || ".");
const src = readFileSync(new URL("../worker-3.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf("function " + name + "("); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return src.slice(a, i + 1); };
const { toFsValue, fsToJs } = new Function(grab("toFsValue") + grab("fsToJs") + "; return { toFsValue, fsToJs };")();
const fs = makeFs(toFsValue, fsToJs);
const d = { DOC_ROOT: ROOT, toFsValue, fsToJs, getToken: async () => "t", fsGet: fs.fsGet, fsList: fs.fsList, fsQuerySub: fs.fsQuerySub, runQuery: fs.runQuery, fsCommit: (...a) => fs.fsCommit(...a) };
const env = { PFM_KEK_v1: Buffer.from(new Uint8Array(32).fill(3)).toString("base64") };
const op = (o, p) => handlePfmOp(o, "u1", p, env, d);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".gz": "application/gzip" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
  const f = path.join(APP, p);
  if (!f.startsWith(APP) || !existsSync(f) || p === "/sw.js") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
}).listen(8766);

const errors = [], check = (ok, msg) => { if (!ok) errors.push(msg); };
const browser = await chromium.launch();

// ── invented screenshots, drawn like the two Bankak layouts ──
const SCREENS = {
  successEn: { file: "success-en.jpg", green: true, rtl: false, title: "Funds Transfer", rows: [
    ["Trx. ID", "21000000001"], ["Date & Time", "02-Nov-2026 14:02:10"], ["From Account", "5555 6666 7777 0001"], ["To Account", "1212 3434 5656 0001"],
    ["To Account Title", "Test Fuel Station"], ["Mobile Number", "N/A"], ["Comment", "5 gallons petrol"], ["Amount", "250,000.00"]] },
  detailsAr: { file: "details-ar.jpg", green: false, rtl: true, title: "تفاصيل المعاملة", rows: [
    ["رقم العملية", "21000000002"], ["التاريخ والوقت", "03-Nov-2026 15:27:02"], ["نوع العملية", "تحويل إلى حساب آخر"], ["المبلغ", "35000.00"],
    ["من", "5555 6666 7777 0001"], ["إلى", "9898 7676 5454 0001"], ["الحالة", "نجاح"], ["إسم المرسل اليه", "مؤسسة الاختبار"], ["التعليق", "ترحيل مواد"]] },
  incomingEn: { file: "incoming-en.jpg", green: false, rtl: false, title: "Transaction Details", rows: [
    ["Trx. ID", "21000000003"], ["Date & Time", "04-Nov-2026 20:12:03"], ["Trx. type", "Other Account Fund Transfer"], ["Amount", "2000000.00"],
    ["From", "4343 2121 1010 0001"], ["To", "5555 6666 7777 0001"], ["Status", "Success"], ["To Account Title", "Test User"], ["Comment", "N/A"]] },
  billAr: { file: "bill-ar.jpg", green: true, rtl: true, title: "نجاح", rows: [
    ["رقم العملية", "21000000004"], ["التاريخ والوقت", "05-Nov-2026 19:17:57"], ["نوع العملية", "سداد فاتورة"], ["المبلغ", "150000.0"],
    ["من", "5555 6666 7777 0001"], ["إلى", "ايصالي"], ["مُعرف الفاتورة", "1111222233334444555566"], ["الحالة", "نجاح"]] },
};
async function draw(s) {
  const page = await browser.newPage({ viewport: { width: 576, height: 1280 }, deviceScaleFactor: 1 });
  await page.goto("http://localhost:8766/manifest.json");   // same origin, so the app's fonts load
  const html = `<style>@font-face{font-family:P;src:url(/fonts/plex-arabic-400.woff2)}@font-face{font-family:L;src:url(/fonts/plex-latin-400.woff2)}
    body{margin:0;width:576px;height:1280px;font-family:L,P,sans-serif;${s.green ? "background:linear-gradient(160deg,#7cb518,#1e8a3a);color:#fff" : "background:#fff;color:#444"}}
    h1{margin:0;padding:${s.green ? "330px 0 40px" : "40px 0 40px"};text-align:center;font-size:28px;font-weight:400}
    .t{margin:${s.green ? "0 48px" : "0"};display:flex;flex-direction:column;gap:${s.green ? "8px" : "0"}}
    .r{display:flex;${s.rtl ? "flex-direction:row-reverse;" : ""}justify-content:space-between;align-items:center;min-height:${s.green ? "52px" : "70px"};padding:0 14px;
       border:${s.green ? "1.5px solid rgba(255,255,255,.95);border-radius:8px" : "1px solid #aaa;margin-top:-1px"};font-size:${s.green ? 22 : 21}px}
    .v{unicode-bidi:isolate;max-width:60%;text-align:${s.rtl ? "left" : "right"}}</style>
    <h1>${s.title}</h1><div class="t">${s.rows.map(([l, v]) => `<div class="r"><span>${l}</span><span class="v" dir="auto">${v}</span></div>`).join("")}</div>`;
  await page.setContent(html); await page.evaluate(() => document.fonts.ready);
  const buffer = await page.screenshot({ type: "jpeg", quality: 90 }); await page.close();
  return { name: s.file, mimeType: "image/jpeg", buffer };
}
const shots = { a: await draw(SCREENS.successEn), b: await draw(SCREENS.detailsAr), c: await draw(SCREENS.incomingEn), e: await draw(SCREENS.billAr) };
if (process.env.SAVE_SHOTS) for (const k in shots) (await import("node:fs")).writeFileSync(path.join(OUT, shots[k].name), shots[k].buffer);

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ar-SA", timezoneId: "Africa/Khartoum" });
await ctx.route("https://unpkg.com/react@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react/umd/react.production.min.js"), contentType: "text/javascript" }));
await ctx.route("https://unpkg.com/react-dom@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react-dom/umd/react-dom.production.min.js"), contentType: "text/javascript" }));
await ctx.route(/gstatic\.com|googleapis\.com|fonts\.g/, (r) => r.fulfill({ body: "", contentType: "text/javascript" }));
await ctx.addInitScript(() => { try { localStorage.setItem("sawaLang", "ar"); } catch (e) {} });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
await page.exposeFunction("__pfmCall", async (o, p) => { try { return { ok: true, ...(await op(o, JSON.parse(JSON.stringify(p || {})))) }; } catch (e) { return { ok: false, error: e.message }; } });
const mount = async () => {
await page.waitForFunction(() => window.SawaApp && typeof AccountantScreen === "function", null, { timeout: 20000 });
await page.evaluate(() => {
  window.SawaSync = window.SawaSync || {};
  window.SawaSync.call = (o, p) => window.__pfmCall(o, p).then((b) => { if (!b.ok) throw new Error(b.error); return b; });
  const host = document.createElement("div"); host.id = "pfmhost"; host.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:" + lightColors.bg;
  document.body.appendChild(host); const st = document.createElement("style"); st.textContent = "body > *:not(#pfmhost){display:none!important}"; document.head.appendChild(st);
  ReactDOM.createRoot(host).render(React.createElement(ThemeContext.Provider, { value: { colors: lightColors, isDark: false } }, React.createElement(ToastProvider, null, React.createElement(AccountantScreen, { onBack() {} }))));
});
};
await page.goto("http://localhost:8766/");
await mount();
const H = page.locator("#pfmhost"), shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await H.getByText("لنبدأ").waitFor();
await H.locator("select").first().selectOption("SDG");
await H.getByRole("button", { name: "ابدأ" }).click();
await H.getByRole("tab", { name: "السجلّ" }).click();
await H.getByRole("button", { name: "استيراد", exact: true }).click();
const dlg = page.getByRole("dialog", { name: "استيراد إيصالات" });
await dlg.getByRole("button", { name: "اختيار الصور" }).waitFor();
await shot("i1-import-empty");

const t0 = Date.now();
await dlg.locator('input[type="file"]').setInputFiles([shots.a, shots.b, shots.c, shots.e]);
await dlg.getByText(/4 صورة · /).waitFor();
// C280: closing the sheet while it reads does not stop it; the accountant screen shows the batch and reopens it
await dlg.getByRole("button", { name: "إغلاق" }).click();
const bar = H.getByRole("button", { name: /استيراد الإيصالات/ });
await bar.waitFor();
check(/قراءة \d من 4|بانتظار/.test(await bar.innerText()), "the bar shows the reading: " + (await bar.innerText()));
check(await H.getByRole("button", { name: /^استيراد\s*\(4\)$/ }).count() === 1, "the Import button counts the batch");
await shot("i1b-closed-while-reading");
await H.getByText(/4 بانتظار المراجعة والإضافة/).waitFor({ timeout: 180000 });
await bar.click();
await dlg.getByText(/4 صورة · /).waitFor();
await page.waitForFunction(() => !/يُقرأ…|في الانتظار|قراءة \d/.test(document.querySelector('[role="dialog"][aria-label="استيراد إيصالات"]').innerText), null, { timeout: 180000 });
const readMs = Date.now() - t0;
await shot("i2-read-before-account");

// the success screen's sender account is proposed as the user's own
const banner = dlg.getByText(/5555 6666 7777 0001/).first();
check(await banner.isVisible(), "own-account question not shown");
await dlg.getByRole("button", { name: "نعم، حسابي" }).click();
await page.waitForTimeout(300);
await shot("i3-after-account");
const text = await dlg.innerText();
check(/4 صورة · 4 جاهزة · 0 تحتاج مراجعة/.test(text), "after confirming the account, all four should be ready: " + text.match(/4 صورة[^\n]*/));
check(/إضافة 4 إلى السجلّ/.test(text), "four rows should be selected");
if (process.env.DEBUG) console.log(text.split("\n").slice(-40).join("\n"));
const amounts = await dlg.locator('input[inputmode="decimal"]').evaluateAll((els) => els.map((e) => e.value));
check(JSON.stringify(amounts) === JSON.stringify(["250000.00", "35000.00", "2000000.00", "150000.00"]), "amounts read: " + amounts);

await dlg.getByRole("button", { name: "إضافة 4 إلى السجلّ" }).click();
await dlg.getByText(/أُضيفت 4/).waitFor({ timeout: 20000 }).catch(async (e) => { await shot("i4-failed"); console.error((await dlg.innerText()).split("\n").filter((l) => /أُضيفت|لم تُحفظ|مسجّلة|bad_|not_|[a-z]_[a-z]/.test(l)).join("\n")); throw e; });
await shot("i4-added");

// server side: three entries from import, ids from the references, receipts attached, one income
const list = await op("pfm.tx.list", { month: "2026-11" });
const imp = list.items.filter((t) => t.source === "import");
check(imp.length === 4, "4 imported entries expected, got " + imp.length);
if (process.env.DEBUG) console.log(JSON.stringify(imp.map((t) => ({ c: t.categoryId, p: t.counterparty, a: t.amount, n: t.note }))));
check(imp.some((t) => t.categoryId === "c_utilities" && t.counterparty === "ايصالي" && t.amount === 15000000 && /1111222233334444555566/.test(t.note || "")), "the bill: utilities, biller, one-decimal amount, bill id in the note");
check(imp.every((t) => /^m_/.test(t.id) && t.hasReceipt), "ids from references and receipts attached");
check(imp.filter((t) => t.kind === "income").length === 1 && imp.find((t) => t.kind === "income").amount === 200000000, "the incoming 2,000,000.00 is income");
check(imp.some((t) => t.categoryId === "c_transport" && t.counterparty === "Test Fuel Station"), "petrol → transport, payee kept");
const prefs = await op("pfm.import.prefs.get", {});
check(prefs.accounts.includes("5555 6666 7777 0001"), "own account remembered");
check(prefs.names["1212343456560001"] === "Test Fuel Station", "confirmed name remembered by account");

// the same screenshot again in this batch: marked as repeated and left out
await dlg.locator('input[type="file"]').setInputFiles([shots.a]);
await page.waitForFunction(() => { const t = document.querySelector('[role="dialog"][aria-label="استيراد إيصالات"]').innerText; return /5 صورة/.test(t) && !/يُقرأ…|قراءة \d/.test(t); }, null, { timeout: 120000 });
check(/مكرّرة في هذه الدفعة/.test(await dlg.innerText()), "a repeat inside the batch is marked");
check(!/هل هو حسابك/.test(await dlg.innerText()), "the account is not asked about again");
// a fresh import later: the server knows the reference and books nothing twice
await dlg.getByRole("button", { name: "إغلاق" }).click();
check(!(await bar.count()), "a batch with nothing left to add is cleared when the sheet closes");
await H.getByRole("button", { name: "استيراد", exact: true }).click();
await dlg.locator('input[type="file"]').setInputFiles([shots.a]);
await page.waitForFunction(() => { const t = document.querySelector('[role="dialog"][aria-label="استيراد إيصالات"]').innerText; return /1 صورة/.test(t) && !/يُقرأ…|قراءة \d/.test(t); }, null, { timeout: 120000 });
await dlg.getByRole("button", { name: "إضافة 1 إلى السجلّ" }).click();
await dlg.getByText(/كانت مسجّلة من قبل فلم تُكرَّر/).waitFor({ timeout: 20000 });
await shot("i5-duplicate");
const after = (await op("pfm.tx.list", { month: "2026-11" })).items.filter((t) => t.source === "import");
check(after.length === 4, "re-import must not add an entry, got " + after.length);

// C281: the batch survives an app restart: pick two, restart while reading, the bar brings them back read
await dlg.locator('input[type="file"]').setInputFiles([shots.b, shots.c]);
await dlg.getByText(/3 صورة · /).waitFor();
await page.reload(); await mount();
await H.getByText(/2 بانتظار المراجعة والإضافة/).waitFor({ timeout: 180000 });
await shot("i6-after-restart");
await bar.click();
await page.waitForFunction(() => { const t = document.querySelector('[role="dialog"][aria-label="استيراد إيصالات"]').innerText; return /3 صورة/.test(t) && !/يُقرأ…|قراءة \d|في الانتظار/.test(t); }, null, { timeout: 120000 });
const kept = await dlg.innerText();
check(/مسجّلة من قبل/.test(kept), "the row added before the restart is still shown as recorded");
const amounts2 = await dlg.locator('input[inputmode="decimal"]').evaluateAll((els) => els.map((e) => e.value));
check(amounts2.includes("35000.00") && amounts2.includes("2000000.00"), "both images read after the restart: " + amounts2);
await dlg.getByRole("button", { name: "إنهاء الدفعة ومسح القائمة" }).click();
await dlg.getByRole("button", { name: "اختيار الصور" }).waitFor();
await page.waitForTimeout(500);
await page.reload(); await mount();
await H.getByRole("tab", { name: "السجلّ" }).waitFor();
await page.waitForTimeout(1500);
check(!(await bar.count()), "a cleared batch does not come back after a restart");

await browser.close(); server.close();
console.log(`read 4 invented screenshots in ${readMs} ms (engine download included)`);
if (errors.length) { console.error("FAIL\n" + errors.join("\n")); process.exitCode = 1; } else console.log("import-check: OK");
