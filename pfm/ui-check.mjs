// Browser check of the Accountant UI: real app files (joined parts), real Worker op code (Node side), in-memory Firestore.
// Usage: node pfm/ui-check.mjs <path to Sawa-app> <dir with node_modules/react@18.3.1 and react-dom@18.3.1> <screenshot dir>
// Needs Playwright with Chromium. The CDNs are replaced by local React and an empty Firebase, so it runs offline.
import { createRequire } from "module";
import http from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { handlePfmOp, handlePfmPublic } = await import("./pfm-worker.mjs");
const { makeFs, ROOT } = await import("./fake-firestore.mjs");

const APP = path.resolve(process.argv[2] || "../Sawa-app"), NM = path.resolve(process.argv[3] || "."), OUT = path.resolve(process.argv[4] || ".");
const src = readFileSync(new URL("../worker-3.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf("function " + name + "("); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return src.slice(a, i + 1); };
const { toFsValue, fsToJs } = new Function(grab("toFsValue") + grab("fsToJs") + "; return { toFsValue, fsToJs };")();
const fs = makeFs(toFsValue, fsToJs);
const d = { DOC_ROOT: ROOT, toFsValue, fsToJs, getToken: async () => "t", fsGet: fs.fsGet, fsList: fs.fsList, fsQuerySub: fs.fsQuerySub, runQuery: fs.runQuery, fsCommit: (...a) => fs.fsCommit(...a) };
const env = { PFM_KEK_v1: Buffer.from(new Uint8Array(32).fill(3)).toString("base64") };
const op = (o, p) => handlePfmOp(o, "u1", p, env, d);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
  if (p.startsWith("/pay/")) p = "/pay.html";   // _redirects: /pay/*  /pay.html  200
  const f = path.join(APP, p);
  if (!f.startsWith(APP) || !existsSync(f) || p === "/sw.js") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
}).listen(8765);

const errors = [];
const browser = await chromium.launch();
async function session(lang, dark) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: lang === "ar" ? "ar-SA" : "en-US", timezoneId: "Europe/Berlin" });
  await ctx.route("https://unpkg.com/react@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react/umd/react.production.min.js"), contentType: "text/javascript" }));
  await ctx.route("https://unpkg.com/react-dom@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react-dom/umd/react-dom.production.min.js"), contentType: "text/javascript" }));
  await ctx.route("https://unpkg.com/html2canvas@1.4.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/html2canvas/dist/html2canvas.min.js"), contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } }));   // C287
  await ctx.route(/gstatic\.com|googleapis\.com|fonts\./, (r) => r.fulfill({ body: "", contentType: "text/javascript" }));
  await ctx.addInitScript((l) => { try { localStorage.setItem("sawaLang", l); } catch (e) {} }, lang);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(lang + " pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && /pfm|Accountant|React/i.test(m.text())) errors.push(lang + " console: " + m.text()); });
  await page.exposeFunction("__pfmCall", async (o, p) => { try { return { ok: true, ...(await op(o, JSON.parse(JSON.stringify(p || {})))) }; } catch (e) { return { ok: false, error: e.message }; } });
  await page.goto("http://localhost:8765/");
  await page.waitForFunction(() => window.SawaApp && typeof AccountantScreen === "function", null, { timeout: 20000 });
  await page.evaluate((dark) => {
    window.SawaSync = window.SawaSync || {};
    window.SawaSync.call = (o, p) => window.__pfmCall(o, p).then((b) => { if (!b.ok) throw new Error(b.error); return b; });
    document.getElementById("root").style.display = "none";
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:" + (dark ? darkColors.bg : lightColors.bg);
    host.id = "pfmhost"; document.body.appendChild(host); const st = document.createElement("style"); st.textContent = "body > *:not(#pfmhost){display:none!important}"; document.head.appendChild(st);
    ReactDOM.createRoot(host).render(React.createElement(ThemeContext.Provider, { value: { colors: dark ? darkColors : lightColors, isDark: dark } },
      React.createElement(ToastProvider, null, React.createElement(AccountantScreen, { onBack() {} }))));
  }, dark);
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const mount = (page, dark) => page.waitForFunction(() => window.SawaApp && typeof AccountantScreen === "function").then(() => page.evaluate((dark) => {
  window.SawaSync = window.SawaSync || {};
  window.SawaSync.call = (o, p) => window.__pfmCall(o, p).then((b) => { if (!b.ok) throw new Error(b.error); return b; });
  const host = document.createElement("div"); host.id = "pfmhost"; host.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:" + (dark ? darkColors.bg : lightColors.bg);
  document.body.appendChild(host); const st = document.createElement("style"); st.textContent = "body > *:not(#pfmhost){display:none!important}"; document.head.appendChild(st);
  ReactDOM.createRoot(host).render(React.createElement(ThemeContext.Provider, { value: { colors: dark ? darkColors : lightColors, isDark: dark } }, React.createElement(ToastProvider, null, React.createElement(AccountantScreen, { onBack() {} }))));
}, dark));

// ── Arabic, light: onboarding → first entry by hand → seeded month → overview, ledger, foreign-currency entry ──
{
  const { ctx, page: pg } = await session("ar", false); const page = pg; const H = pg.locator("#pfmhost");
  await H.getByText("لنبدأ").waitFor();
  await H.locator("select").first().selectOption("SAR");
  await shot(page, "1-onboarding-ar");
  await H.getByRole("button", { name: "ابدأ" }).click();
  await H.getByText("لا حركات في هذا الشهر").waitFor();
  // first entry through the UI
  await H.getByRole("button", { name: "سجّل أوّل حركة" }).click();
  await H.locator('input[inputmode="decimal"]').first().fill("45.50");
  await H.getByRole("button", { name: "طعام ومشتريات" }).click();
  await H.locator('input[dir="auto"]').first().fill("بقالة الحيّ");
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByRole("heading", { level: 2 }).waitFor();
  // more history, straight through the ops (same code path as the UI)
  const add = (k, kind, amount, cat, date, extra = {}) => op("pfm.tx.add", { idemKey: "seed-key-" + k, kind, amount, categoryId: cat, date, ...extra });
  await add("s1", "income", "12000", "c_salary", "2026-11-01", { counterparty: "شركة الأفق" });
  await add("s2", "expense", "3500", "c_rent", "2026-11-01", { counterparty: "المالك" });
  await add("s3", "expense", "420", "c_utilities", "2026-11-03");
  await add("s4", "expense", "180", "c_telecom", "2026-11-04", { counterparty: "STC" });
  await add("s5", "income", "1500", "c_freelance", "2026-11-05", { note: "تصميم شعار" });
  await add("s6", "expense", "60", "c_transport", "2026-11-05", { currency: "USD", fxRate: "3.75", counterparty: "Uber" });
  await add("s7", "expense", "25", "c_food", "2026-11-06", { currency: "GBP" });
  for (const [m, inc, exp] of [["2026-06", "11000", "9800"], ["2026-07", "11000", "12500"], ["2026-08", "12000", "8000"], ["2026-09", "12000", "9100"], ["2026-10", "13500", "9900"]]) {
    await add("h-in-" + m, "income", inc, "c_salary", m + "-01"); await add("h-out-" + m, "expense", exp, "c_rent", m + "-02");
  }
  await page.reload();
  await page.waitForFunction(() => window.SawaApp && typeof AccountantScreen === "function");
  await page.evaluate(() => {
    window.SawaSync = window.SawaSync || {};
    window.SawaSync.call = (o, p) => window.__pfmCall(o, p).then((b) => { if (!b.ok) throw new Error(b.error); return b; });
    document.getElementById("root").style.display = "none";
    const host = document.createElement("div"); host.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:" + lightColors.bg; host.id = "pfmhost"; document.body.appendChild(host); const st = document.createElement("style"); st.textContent = "body > *:not(#pfmhost){display:none!important}"; document.head.appendChild(st);
    ReactDOM.createRoot(host).render(React.createElement(ThemeContext.Provider, { value: { colors: lightColors, isDark: false } }, React.createElement(ToastProvider, null, React.createElement(AccountantScreen, { onBack() {} }))));
  });
  await H.getByRole("heading", { level: 2 }).waitFor();
  await H.getByText("أين ذهب المال").waitFor();
  await page.waitForTimeout(900);   // the day ruler fills once (≈ 0.6 s)
  const ruler = await H.locator("[data-day]").evaluateAll((els) => els.map((e) => e.dataset.day + ":" + getComputedStyle(e).backgroundColor));
  const filled = ruler.filter((x) => /^(done|today):rgb\(15, 118, 110\)/.test(x)).length, doneN = ruler.filter((x) => !x.startsWith("left")).length;
  if (!doneN || filled !== doneN) errors.push(`day ruler: ${filled} of ${doneN} past days filled teal`);
  await shot(page, "2-overview-ar");
  await H.locator("div.overflow-y-auto").last().evaluate((e) => e.scrollTo(0, e.scrollHeight));
  await shot(page, "3-overview-ar-bottom");
  await H.getByRole("tab", { name: "السجلّ" }).click();
  await H.getByText("بقالة الحيّ").waitFor();
  await shot(page, "4-ledger-ar");
  // edit the GBP entry that is waiting for a rate
  await H.getByRole("button", { name: /بانتظار السعر/ }).click();
  await H.getByText(/سعر الصرف/).waitFor();
  await H.locator('input[inputmode="decimal"]').nth(1).fill("4.10");
  await shot(page, "5-edit-fx-ar");
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByRole("tab", { name: "نظرة عامّة" }).click();
  await H.getByRole("heading", { level: 2 }).waitFor();
  const pending = await H.getByText(/تحتاج سعر صرف/).count();
  if (pending) errors.push("rate-pending banner still shown after adding the rate");
  // previous month navigation
  await H.getByRole("button", { name: "الشهر السابق" }).click();
  await H.getByText(/أكتوبر/).first().waitFor();
  await ctx.close();
}

// ── P2 (Arabic): budgets, rules, repeat, suggested entries, alerts ──
{
  const { ctx, page: pg } = await session("ar", false); const page = pg; const H = pg.locator("#pfmhost");
  await H.getByRole("heading", { level: 2 }).waitFor();
  // a budget for food, through the Budgets tab
  await H.getByRole("tab", { name: "الميزانيّات" }).click();
  await H.getByRole("button", { name: "ميزانيّة أخرى" }).or(H.getByRole("button", { name: "أضف ميزانيّة" })).first().click();
  await H.locator("select").first().selectOption("c_food");
  await H.locator('input[inputmode="decimal"]').fill("200");
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByText(/بقي/).first().waitFor();
  await H.getByRole("tab", { name: "السجلّ" }).click();   // the add button is hidden on the Budgets tab
  // an expense with a payee, and "always use this category"
  await H.getByRole("button", { name: "حركة جديدة" }).click();
  await H.locator('input[inputmode="decimal"]').first().fill("30");
  await H.getByRole("button", { name: "مواصلات", exact: true }).click();
  await H.locator('input[dir="auto"]').first().fill("Uber");
  await H.getByText(/استعمل «مواصلات» دائماً/).click();
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByText("حركة جديدة", { exact: true }).waitFor({ state: "detached" });
  // the rule now picks the category; this one also repeats monthly
  await H.getByRole("button", { name: "حركة جديدة" }).click();
  await H.locator('input[inputmode="decimal"]').first().fill("120");
  await H.locator('input[dir="auto"]').first().fill("UBER monthly pass");
  await H.getByText(/اختيرت الفئة بقاعدة/).waitFor();
  await H.locator("select").nth(1).selectOption("monthly");
  await shot(page, "p2-1-rule-repeat-ar");
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByText("حركة جديدة", { exact: true }).waitFor({ state: "detached" });
  // a food expense that crosses the budget thresholds → alert
  await H.getByRole("button", { name: "حركة جديدة" }).click();
  await H.locator('input[inputmode="decimal"]').first().fill("90");
  await H.getByRole("button", { name: "طعام ومشتريات", exact: true }).click();
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByText("حركة جديدة", { exact: true }).waitFor({ state: "detached" });
  // a recurring entry that started months ago → suggestions (same op the form uses)
  await op("pfm.recurring.upsert", { kind: "expense", amount: "60", categoryId: "c_telecom", counterparty: "STC", rule: { freq: "monthly", day: 2 }, startDate: "2026-09-02" });
  await page.reload();
  await mount(page, false);
  await H.getByText("يحتاجك", { exact: true }).waitFor(); await H.getByText(/تجاوزت ميزانيّة/).waitFor();
  if (await H.getByText(/استُهلك/).count()) errors.push("lower-threshold alert shown next to the over-budget one");
  await H.getByText(/للتأكيد/).waitFor();
  await page.waitForTimeout(900);
  await shot(page, "p2-2-overview-ar");
  await H.getByRole("tab", { name: "الميزانيّات" }).click();
  await H.getByText(/تجاوز بـ|بقي/).first().waitFor();
  await shot(page, "p2-3-budgets-ar");
  await H.getByRole("tab", { name: "نظرة عامّة" }).click();
  await H.getByRole("button", { name: "إخفاء التنبيهات" }).click();
  if (await H.getByText(/تجاوزت ميزانيّة/).count()) errors.push("alerts still shown after dismiss");
  await H.getByText(/للتأكيد/).click();
  await H.getByText(/مقترحة/).first().waitFor();
  await H.getByText(/مقترحة/).first().scrollIntoViewIfNeeded();
  await shot(page, "p2-4-ledger-suggested-ar");
  await H.getByRole("button", { name: "تأكيد" }).first().click();
  await H.getByRole("button", { name: /المتكرّرة/ }).click();
  await H.getByText("STC").first().waitFor(); await H.getByText(/UBER monthly pass/).first().waitFor();
  await shot(page, "p2-5-recurring-ar");
  await ctx.close();
}
const g2 = await op("pfm.get");
if (g2.rules.length !== 1 || g2.rules[0].contains !== "Uber") errors.push("rule not saved: " + JSON.stringify(g2.rules));
if (g2.recurring.length !== 2) errors.push("expected 2 recurring, got " + g2.recurring.length);
if (g2.suggestedCount !== 2) errors.push("expected 2 suggestions left (Sep, Oct, Nov due; one confirmed), got " + g2.suggestedCount);
const auto = (await op("pfm.tx.list", { month: "2026-11" })).items.find((t) => t.counterparty === "UBER monthly pass");
if (!auto || auto.categoryId !== "c_transport") errors.push("rule did not pick Transport");
const alertsFired = (await op("pfm.alerts.list", {})).alerts.map((a) => a.categoryId + ":" + (a.kind === "pace" ? "pace" : a.bp));
if (!alertsFired.some((x) => x === "c_food:10000")) errors.push("expected the food 100% alert, got " + alertsFired.join(","));

// ── P3 (Arabic): business details, logo, tax, account, invoice → send → payment → print ──
{
  const { ctx, page: pg } = await session("ar", false); const page = pg; const H = pg.locator("#pfmhost");
  page.on("dialog", (dl) => dl.accept());
  // a logo file, made here
  const lp = await ctx.newPage(); await lp.setContent('<div style="width:240px;height:80px;background:#0f766e;color:#fff;font:bold 34px sans-serif;display:flex;align-items:center;justify-content:center;border-radius:12px">KDS</div>');
  await lp.locator("div").screenshot({ path: `${OUT}/logo.png`, omitBackground: true }); await lp.close();
  await H.getByRole("heading", { level: 2 }).waitFor();
  await H.getByRole("tab", { name: "الفواتير" }).click();
  await H.getByText("لا مبالغ مستحقّة لك الآن").waitFor();
  await H.getByRole("button", { name: "بيانات النشاط" }).first().click();
  await H.getByText("اسم النشاط").waitFor();
  await H.locator('input[type="file"]').setInputFiles(`${OUT}/logo.png`);
  await H.getByRole("img", { name: "الشعار الحاليّ" }).waitFor();
  await H.getByLabel("اسم النشاط").fill("استوديو خالد للتصميم");
  await H.getByLabel("الهاتف", { exact: true }).fill("+966 51 234 5678");
  await H.getByLabel("العنوان", { exact: true }).fill("الرياض، طريق الملك فهد");
  await H.getByLabel("رمز سوا", { exact: true }).fill("136-860-8541");   // C288
  await H.getByText("أفرض ضريبة على فواتيري").click();
  await H.getByLabel("رقمي الضريبيّ").fill("300123456700003");
  await H.getByLabel("اسم الضريبة كما يظهر على الفاتورة").fill("ضريبة القيمة المضافة");
  await H.getByRole("button", { name: "＋ نسبة" }).click();
  await H.getByLabel("اسم النسبة").fill("أساسيّة"); await H.getByLabel("النسبة", { exact: true }).fill("15");
  await H.getByRole("radio", { name: "افتراضيّة" }).check();
  await H.getByRole("button", { name: "حفظ بيانات النشاط" }).click();
  await H.getByText("لا مبالغ مستحقّة لك الآن").waitFor();
  // receiving account
  await H.getByRole("button", { name: "بيانات النشاط" }).first().click();
  await H.getByRole("button", { name: /＋ حساب/ }).click();
  await H.getByLabel("اسم البنك").fill("مصرف الراجحي");
  await H.getByLabel("رقم الحساب أو الآيبان").fill("SA03 8000 0000 6080 1016 7519");
  await H.getByRole("button", { name: "إضافة الحساب" }).click();
  await H.getByText("•••• 7519").waitFor();
  await shot(page, "p3-1-business-ar");
  await H.getByRole("button", { name: "حفظ بيانات النشاط" }).click();
  // a new invoice
  await H.getByRole("button", { name: /فاتورة جديدة/ }).click();
  await H.getByPlaceholder("الاسم", { exact: true }).fill("شركة النيل للتجارة");
  await H.getByLabel("هاتف العميل").fill("+249 911 111 111");   // C288
  await H.getByLabel("عنوان العميل").fill("الخرطوم بحري");
  await H.getByLabel("رمز سوا للعميل").fill("2223334445");
  await H.getByLabel("الوصف").first().fill("تصميم هويّة بصريّة");
  await H.getByLabel("سعر الوحدة").first().fill("4500");
  await H.getByRole("button", { name: "＋ بند آخر" }).click();
  await H.getByLabel("الوصف").nth(1).fill("استضافة شهريّة"); await H.getByLabel("الكمّيّة").nth(1).fill("3"); await H.getByLabel("سعر الوحدة").nth(1).fill("250");
  if ((await H.getByRole("button", { name: /مصرف الراجحي/ }).getAttribute("aria-pressed")) !== "true") errors.push("the saved account is not pre-selected on a new invoice");
  await H.getByText("الإجماليّ", { exact: true }).waitFor();
  await shot(page, "p3-2-editor-ar");
  const taxSel = await H.locator("select").evaluateAll((els) => els.filter((e) => e.options.length < 10).map((e) => e.selectedOptions[0] && e.selectedOptions[0].text));
  if (!taxSel.length || !taxSel.every((x) => /15%/.test(x))) errors.push("tax menus don't show the default 15% rate: " + JSON.stringify(taxSel));
  const total = await H.getByText("الإجماليّ", { exact: true }).locator("xpath=..").innerText();
  if (!/6,037\.50/.test(total)) errors.push("editor total (4500 + 750 + 15% VAT = 6,037.50) shows: " + total);
  await H.getByRole("button", { name: "إرسال", exact: true }).click();
  await H.getByText(/INV-\d{4}-0001/).first().waitFor();
  // a partial payment
  await H.getByRole("button", { name: "تسجيل دفعة" }).click();
  await H.getByLabel(/المبلغ المستلم/).fill("2000");
  await H.getByRole("button", { name: "سجّل الدفعة" }).click();
  await H.getByText(/متبقٍّ من/).waitFor();
  await shot(page, "p3-3-detail-ar");
  // C287: "Download PDF" makes a real file (the server's, or here on the device); "Print" stays for browsers
  {
    const dl = page.waitForEvent("download", { timeout: 60000 });
    await H.getByRole("button", { name: "تنزيل PDF" }).click();
    const file = await dl;
    const bytes = readFileSync(await file.path());
    if (bytes.subarray(0, 5).toString() !== "%PDF-") errors.push("invoice PDF is not a PDF");
    const pages = (bytes.toString("latin1").match(/\/Type\/Page\//g) || []).length;   // C288: a short invoice is one page
    if (pages !== 1) errors.push("short invoice PDF has " + pages + " pages");
    if (!/^invoice-INV-\d{4}-0001\.pdf$/.test(file.suggestedFilename())) errors.push("invoice PDF name: " + file.suggestedFilename());
    await file.saveAs(`${OUT}/p3-invoice-device-ar.pdf`);
    await H.getByText(/نُزّل ملفّ PDF/).waitFor();
  }
  // print: the server renders the page into a frame
  await H.getByRole("button", { name: "طباعة", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((f) => /INV-\d{4}-0001/.test(f.srcdoc || "")));
  const printed = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.srcdoc).find((x) => /INV-/.test(x)));
  const pp = await ctx.newPage(); await pp.setViewportSize({ width: 794, height: 1100 }); await pp.setContent(printed);
  await pp.screenshot({ path: `${OUT}/p3-4-printed-ar.png`, fullPage: true }); await pp.pdf({ path: `${OUT}/p3-invoice-ar.pdf`, format: "A4", printBackground: true }); await pp.close();
  if (!/data:image\/(webp|png)/.test(printed)) errors.push("printed invoice has no logo");
  if (!printed.includes("SA0380000000608010167519")) errors.push("printed invoice has no account number");
  for (const s of ["+966 51 234 5678", "136-860-8541", "الرياض، طريق الملك فهد", "+249 911 111 111", "الخرطوم بحري", "222-333-4445"]) if (!printed.includes(s)) errors.push("printed invoice lacks " + s);
  await H.getByRole("button", { name: "إغلاق" }).click();
  await H.getByText(/عند عملائك/).waitFor();
  await shot(page, "p3-5-invoices-ar");
  await ctx.close();
}
const invs = await op("inv.list", {});
if (invs.items.length !== 1 || invs.items[0].status !== "sent" || invs.items[0].amountDue !== 403750) errors.push("invoice state: " + JSON.stringify(invs.items));

// ── P4: the client opens the pay link (no account), reports the payment; the issuer confirms ──
{
  const inv0 = (await op("inv.list", {})).items[0];
  const full = (await op("inv.get", { id: inv0.id })).invoice;
  const link = `http://localhost:8765/pay/${full.payLinkToken}`;
  const payPage = async (scheme, locale) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale, colorScheme: scheme });
    await ctx.route(/fonts\./, (r) => r.fulfill({ body: "" }));
  await ctx.route("https://unpkg.com/html2canvas@1.4.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/html2canvas/dist/html2canvas.min.js"), contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } }));   // C287
    await ctx.route("https://sawa-deploy-test.khalidlinux87.workers.dev/pfm/pay", async (r) => {
      const b = JSON.parse(r.request().postData() || "{}");
      let out; try { out = { ok: true, ...(await handlePfmPublic(b.op, b.payload, env, d, "203.0.113.7")) }; } catch (e) { out = { ok: false, error: e.message }; }
      await r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(out) });
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pay pageerror: " + e.message));
    await page.goto(link);
    return { ctx, page };
  };
  {
    const { ctx, page } = await payPage("light", "ar-SA");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const h1 = await page.getByRole("heading", { level: 1 }).innerText();
    if (!/مطلوب منك/.test(h1) || !/4,037\.50/.test(h1)) errors.push("pay page headline: " + h1);
    if (!(await page.getByText("SA0380000000608010167519").count())) errors.push("pay page shows no account number");
    await page.screenshot({ path: `${OUT}/p4-1-pay-ar.png`, fullPage: true });
    await page.getByRole("button", { name: /عرض الفاتورة كاملةً/ }).click();
    await page.waitForFunction(() => /INV-/.test(document.getElementById("frame").srcdoc || ""));
    await page.getByRole("button", { name: "إغلاق" }).click();
    // C287: the full invoice as a PDF from the pay page
    await page.getByRole("button", { name: /عرض الفاتورة كاملةً/ }).click();
    {
      const dl = page.waitForEvent("download", { timeout: 60000 });
      await page.getByRole("button", { name: "تنزيل PDF" }).click();
      const f = await dl, pb = readFileSync(await f.path()); if (pb.subarray(0, 5).toString() !== "%PDF-") errors.push("pay page PDF is not a PDF");
      const n = (pb.toString("latin1").match(/\/Type\/Page\//g) || []).length; if (n !== 1) errors.push("pay page PDF has " + n + " pages");   // C288
      await f.saveAs(`${OUT}/p4-invoice-pay-page-ar.pdf`);
    }
    await page.getByRole("button", { name: "إغلاق" }).click();
    // C287: a part payment with a PDF receipt
    await page.getByRole("radio", { name: /دفعة جزئيّة/ }).check();
    await page.getByLabel("المبلغ الذي دفعته الآن").fill("1000");
    await page.getByLabel(/رقم العمليّة/).fill("FT2611-7781");
    writeFileSync(`${OUT}/receipt.pdf`, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    await page.getByLabel(/إيصال الدفع/).setInputFiles(`${OUT}/receipt.pdf`);
    await page.getByText(/مُرفق: receipt\.pdf/).waitFor();
    // C294: an error (no name yet) redraws the form: the receipt and the typed fields stay
    await page.getByRole("button", { name: "أبلغ عن الدفع" }).click();
    await page.getByText("اكتب اسمك.").waitFor();
    if (!(await page.getByText(/مُرفق: receipt\.pdf/).count())) errors.push("the receipt was dropped by an error redraw");
    // C294: the tab reloads (a phone after the camera or gallery): the draft and the receipt come back
    await page.reload();
    await page.getByText(/مُرفق: receipt\.pdf/).waitFor({ timeout: 10000 }).catch(() => errors.push("the receipt was lost on a tab reload"));
    if ((await page.getByLabel("المبلغ الذي دفعته الآن").inputValue()) !== "1000") errors.push("the part amount was lost on a tab reload");
    if ((await page.getByLabel(/رقم العمليّة/).inputValue()) !== "FT2611-7781") errors.push("the reference was lost on a tab reload");
    await page.getByLabel("اسمك").fill("سارة أحمد");
    await page.screenshot({ path: `${OUT}/p4-2a-pay-partial-form-ar.png`, fullPage: true });
    await page.getByRole("button", { name: "أبلغ عن الدفع" }).click();
    await page.getByText(/وصل بلاغك/).waitFor();
    await page.getByText("مدفوعة جزئيّاً").waitFor();
    await page.screenshot({ path: `${OUT}/p4-2-pay-reported-ar.png`, fullPage: true });
    // the rest, in full, with a photo
    await page.getByRole("button", { name: "الإبلاغ عن دفعة أخرى" }).click();
    await page.getByText(/كلّ المتبقّي/).waitFor();
    await page.getByLabel("اسمك").fill("سارة أحمد");
    if (await page.getByText(/مُرفق:/).count()) errors.push("the sent receipt was still attached to the next report");
    await page.getByLabel(/إيصال الدفع/).setInputFiles(`${OUT}/logo.png`);
    await page.getByText(/مُرفق: logo\.png/).waitFor();
    await page.getByRole("button", { name: "أبلغ عن الدفع" }).click();
    await page.getByText(/أبلغتَ عن دفع المبلغ كاملاً/).waitFor();
    await page.screenshot({ path: `${OUT}/p4-2b-pay-pending-ar.png`, fullPage: true });
    if (await page.locator("#claim").count()) errors.push("pay form still shown with nothing left to report");
    await ctx.close();
  }
  // the issuer sees it, checks the receipt, confirms
  {
    const { ctx, page: pg } = await session("ar", false); const page = pg; const H = pg.locator("#pfmhost");
    page.on("dialog", (dl) => dl.accept());
    await H.getByText(/2 بلاغات دفع من عملائك/).waitFor();
    await H.getByText(/بلاغات دفع من عملائك/).click();
    await H.getByText(/2 بلاغات دفع تنتظر تحقّقك/).waitFor();
    await H.getByRole("button", { name: /شركة النيل/ }).click();
    await H.getByText(/يقول إنّه دفع/).first().waitFor();
    await H.getByText("مدفوعة — بانتظار تحقّقك").first().waitFor();
    await shot(page, "p4-3-report-ar");
    {
      const dl = page.waitForEvent("download", { timeout: 30000 });
      await H.getByRole("button", { name: "الإيصال (PDF)" }).click();
      const f = await dl; if (readFileSync(await f.path()).subarray(0, 5).toString() !== "%PDF-") errors.push("PDF receipt did not open as a PDF");
    }
    await H.getByRole("button", { name: "الإيصال", exact: true }).click();
    await H.getByRole("img", { name: "صورة الإيصال" }).waitFor();
    await H.getByRole("img", { name: "صورة الإيصال" }).click();
    await H.getByRole("button", { name: "وصل — أكّد" }).first().click();
    await H.getByText(/متبقٍّ من/).waitFor();
    await H.getByRole("button", { name: "وصل — أكّد" }).first().click();
    await H.getByText(/دُفعت كاملةً/).waitFor();
    await ctx.close();
  }
  {
    const { ctx, page } = await payPage("dark", "en-US");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const h1 = await page.getByRole("heading", { level: 1 }).innerText();
    if (!/دُفعت هذه الفاتورة كاملةً/.test(h1)) errors.push("pay page after confirm: " + h1);
    await page.getByRole("button", { name: "English" }).click();
    await page.getByText("This invoice is paid in full.").waitFor();
    await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/p4-4-pay-paid-en-dark.png`, fullPage: true });
    await ctx.close();
  }
  const after = (await op("inv.get", { id: inv0.id })).invoice;
  if (after.status !== "paid") errors.push("invoice not paid after confirming the report: " + after.status);
  if (!after.payments.some((p) => p.state === "succeeded" && p.payer && p.payer.name === "سارة أحمد")) errors.push("confirmed report not recorded with the payer");
}

// ── English, dark: overview of the same data ──
{
  const { ctx, page: pg } = await session("en", true); const page = pg; const H = pg.locator("#pfmhost");
  await H.getByRole("heading", { level: 2 }).waitFor();
  await H.getByText("Where the money went").waitFor();
  await page.waitForTimeout(900);
  await shot(page, "6-overview-en-dark");
  await H.getByRole("button", { name: "New entry" }).click();
  await H.getByRole("tab", { name: "Income" }).waitFor();
  await H.locator('input[inputmode="decimal"]').first().fill("1.005");
  await H.locator("select").first().selectOption("USD");
  await H.getByRole("button", { name: "Other expenses" }).click();
  await H.locator('input[inputmode="decimal"]').nth(1).fill("3.75");
  await H.getByRole("button", { name: "Save" }).click();
  await H.getByRole("alert").waitFor();
  const msg = await H.getByRole("alert").innerText();
  if (!/decimal places/.test(msg)) errors.push("expected decimal-places error, got: " + msg);
  await shot(page, "7-error-en-dark");
  await ctx.close();
}

// ── P5 (Arabic): a receipt photo on an entry, then a CSV export ──
{
  const { ctx, page: pg } = await session("ar", false); const page = pg; const H = pg.locator("#pfmhost");
  await H.getByRole("heading", { level: 2 }).waitFor();
  await H.getByRole("tab", { name: "السجلّ" }).click();
  await H.getByText("بقالة الحيّ").click();
  await H.getByText("صورة الإيصال (اختياريّ)").waitFor();
  // a 1600×1200 PNG with transparency: the app must turn it into a ≤ 1280 px JPEG on white, ≤ 400 KB
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 1600; c.height = 1200; const g = c.getContext("2d");
    for (let i = 0; i < 600; i++) { g.fillStyle = `hsla(${(i * 7) % 360},70%,50%,.6)`; g.fillRect((i * 37) % 1600, (i * 53) % 1200, 140, 90); } return c.toDataURL("image/png"); });
  await H.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(png.split(",")[1], "base64") });
  await H.getByRole("button", { name: "عرض الإيصال الجديد" }).waitFor();
  await shot(page, "p5-1-receipt-picked-ar");
  await H.getByRole("button", { name: "حفظ" }).click();
  await H.getByRole("tab", { name: "السجلّ" }).waitFor();
  await page.waitForTimeout(500);
  const row = [...fs.docs].find(([n, e]) => n.includes("/pfm/u1/tx/") && e.data.hasReceipt);
  if (!row) errors.push("P5: no entry carries hasReceipt after saving with a photo");
  else {
    const got = await op("pfm.tx.receipt.get", { id: row[0].split("/").pop() });
    const bytes = got.data ? Buffer.from(got.data.split(",")[1], "base64").length : 0;
    if (!/^data:image\/jpeg;base64,/.test(got.data || "") || bytes > 400 * 1024) errors.push(`P5: stored receipt is not a JPEG ≤ 400 KB (${(got.data || "").slice(0, 30)}, ${bytes} bytes)`);
    const dim = await page.evaluate((src) => new Promise((r) => { const i = document.createElement("img"); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = src; }), got.data);
    if (Math.max(...dim) > 1280) errors.push("P5: receipt not shrunk: " + dim.join("×"));
  }
  // the row shows the clip; reopening the entry shows the photo
  await H.getByText("بقالة الحيّ").waitFor();
  await shot(page, "p5-2-ledger-ar");
  await H.getByText("بقالة الحيّ").click();
  await H.getByRole("button", { name: /عرض الإيصال/ }).scrollIntoViewIfNeeded();
  await shot(page, "p5-3a-receipt-field-ar");
  await H.getByRole("button", { name: /عرض الإيصال/ }).click();
  await H.getByRole("dialog", { name: "الإيصال" }).locator("img").waitFor();
  await shot(page, "p5-3-receipt-view-ar");
  await H.getByRole("dialog", { name: "الإيصال" }).click();
  await H.getByRole("button", { name: "إغلاق" }).first().click().catch(() => page.keyboard.press("Escape"));
  // export: last 3 months, saved as a file
  await H.getByRole("button", { name: /تصدير/ }).click();
  await H.getByText("تصدير السجلّ").waitFor();
  await H.getByRole("button", { name: "آخر 3 أشهر" }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), H.getByRole("button", { name: "تنزيل CSV" }).click()]);
  const csv = readFileSync(await dl.path(), "utf8");
  if (!/^sawa-accountant-\d{4}-\d{2}_\d{4}-\d{2}\.csv$/.test(dl.suggestedFilename())) errors.push("P5: export file name " + dl.suggestedFilename());
  if (!csv.startsWith("﻿التاريخ,النوع,الفئة,المبلغ,العملة,المبلغ بـSAR,")) errors.push("P5: CSV header " + JSON.stringify(csv.slice(0, 80)));
  if (!csv.split("\r\n").some((l) => l.includes("بقالة الحيّ") && l.endsWith(",نعم"))) errors.push("P5: the entry with a receipt is missing from the CSV");
  if (!csv.includes(",102.50,4.10,")) errors.push("P5: the GBP entry's SAR amount and rate are missing from the CSV");
  await H.getByText(/صُدِّرت \d+ حركة/).waitFor();
  await shot(page, "p5-4-export-ar");
  await ctx.close();
}

// ── Wallet entry point: the real WalletScreen lists the service and opens the accountant ──
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ar-SA", timezoneId: "Europe/Berlin" });
  await ctx.route("https://unpkg.com/react@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react/umd/react.production.min.js"), contentType: "text/javascript" }));
  await ctx.route("https://unpkg.com/react-dom@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react-dom/umd/react-dom.production.min.js"), contentType: "text/javascript" }));
  await ctx.route("https://unpkg.com/html2canvas@1.4.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/html2canvas/dist/html2canvas.min.js"), contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } }));   // C287
  await ctx.route(/gstatic\.com|googleapis\.com|fonts\./, (r) => r.fulfill({ body: "", contentType: "text/javascript" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("wallet pageerror: " + e.message));
  await page.exposeFunction("__pfmCall", async (o, p) => { try { return { ok: true, ...(await op(o, JSON.parse(JSON.stringify(p || {})))) }; } catch (e) { return { ok: false, error: e.message }; } });
  await page.goto("http://localhost:8765/");
  await page.waitForFunction(() => window.SawaApp && typeof WalletScreen === "function");
  await page.evaluate(() => {
    window.SawaSync = window.SawaSync || {}; window.SawaSync.call = (o, p) => window.__pfmCall(o, p).then((b) => { if (!b.ok) throw new Error(b.error); return b; });
    const host = document.createElement("div"); host.id = "pfmhost"; host.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:" + lightColors.bg; document.body.appendChild(host);
    const st = document.createElement("style"); st.textContent = "body > *:not(#pfmhost){display:none!important}"; document.head.appendChild(st);
    ReactDOM.createRoot(host).render(React.createElement(ThemeContext.Provider, { value: { colors: lightColors, isDark: false } }, React.createElement(ToastProvider, null,
      React.createElement(WalletScreen, { balance: 0, transactions: [], cardNumber: "4000000000000000", linkedMethods: [], onBack() {} }))));
  });
  const H = page.locator("#pfmhost");
  await H.getByText("المحاسب الشخصيّ").first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/0-wallet-entry-ar.png` });
  await H.getByText("المحاسب الشخصيّ").first().click();
  await H.getByRole("heading", { level: 2 }).waitFor({ timeout: 15000 });
  await ctx.close();
}

// server state matches: SAR totals for November
const nov = fs.docs.get(`${ROOT}/pfm/u1/months/2026-11`).data;
console.log(JSON.stringify({ income: nov.income, expense: nov.expense, txCount: nov.txCount, ratePending: nov.ratePending || 0 }));
await browser.close(); server.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "ui: ok"); if (errors.length) process.exitCode = 1;
