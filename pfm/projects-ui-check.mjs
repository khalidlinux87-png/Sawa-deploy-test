// Browser check of the Projects tab (P6c). Built from the same harness as ui-check.mjs.
// Browser check of the Accountant UI: real app files (joined parts), real Worker op code (Node side), in-memory Firestore.
// Usage: node pfm/ui-check.mjs <path to Sawa-app> <dir with node_modules/react@18.3.1 and react-dom@18.3.1> <screenshot dir>
// Needs Playwright with Chromium. The CDNs are replaced by local React and an empty Firebase, so it runs offline.
import { createRequire } from "module";
import http from "node:http";
import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { handlePfmOp, handlePfmPublic } = await import("./pfm-worker.mjs");
const { makeFs, ROOT } = await import("./fake-firestore.mjs");

const APP = path.resolve(process.argv[2] || "../Sawa-app"), NM = path.resolve(process.argv[3] || "."), OUT = path.resolve(process.argv[4] || ".");
copyFileSync(path.join(APP, "icons/icon-192.png"), path.join(OUT, "receipt.png"));   // C287: a photo to attach
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


// ── Arabic, light: onboarding → create a project → draft and approve the estimate → an entry on a line → invite ──
{
  const { ctx, page } = await session("ar", false); const H = page.locator("#pfmhost");
  await H.getByText("لنبدأ").waitFor();
  await H.getByRole("button", { name: "ابدأ" }).click();
  await H.getByRole("tab", { name: "المشاريع" }).waitFor();
  await H.getByRole("tab", { name: "المشاريع" }).click();
  await H.getByText("لا توجد مشاريع بعد").waitFor();
  await shot(page, "p1-projects-empty");
  await H.getByRole("button", { name: "مشروع جديد" }).click();
  await H.getByLabel("اسم المشروع").fill("بيت العائلة");
  await H.getByLabel("الميزانيّة المستهدفة").fill("3000");
  await shot(page, "p2-new-project");
  await H.getByRole("button", { name: "إنشاء المشروع" }).click();
  await H.getByRole("heading", { name: "بيت العائلة" }).or(H.getByText("بيت العائلة").first()).waitFor();
  await H.getByRole("tab", { name: "التقدير" }).click();
  await H.getByRole("button", { name: "إنشاء تقدير" }).click();
  await H.getByRole("button", { name: "إضافة بند" }).waitFor();
  await H.getByRole("button", { name: "إضافة بند" }).click();
  await H.getByLabel("البند", { exact: true }).fill("إسمنت");
  await H.getByLabel("الوحدة", { exact: true }).fill("كيس");
  await H.getByLabel("الكمّيّة", { exact: true }).fill("100");
  await H.getByLabel("سعر الوحدة", { exact: true }).fill("10");
  // C287: the quote's date and supplier
  await H.getByLabel("تاريخ السعر").fill("2026-10-01");
  await H.getByLabel("المورّد (اختياري)").fill("أسمنت عطبرة");
  await H.getByRole("button", { name: "حفظ المسوّدة" }).click();
  await H.getByText(/سُجّل هذا السعر/).waitFor({ timeout: 10000 });
  await shot(page, "c284-1-estimate-dated");
  await H.getByText("مراجعة 1").waitFor({ timeout: 10000 }).catch(() => {});
  await shot(page, "p3-estimate-draft");
  page.once("dialog", (d) => d.accept());
  await H.getByRole("button", { name: "اعتماد التقدير" }).click();
  await H.getByText("الفعلي:").first().waitFor({ timeout: 10000 });
  await H.getByText(/السعر بتاريخ .*أسمنت عطبرة/).waitFor();
  await shot(page, "p4-estimate-approved");
  // C287: a supplier's quote (PDF) on the line, with the price it quotes
  await H.getByRole("button", { name: "المرفقات", exact: true }).first().click();
  await H.getByText("لا مرفقات بعد.").waitFor();
  await H.getByLabel("تاريخ المستند").fill("2026-10-05");
  await H.getByLabel(/سعر الوحدة في العرض/).fill("9.5");
  writeFileSync(path.join(OUT, "quote.pdf"), "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  await H.locator('input[type="file"]').setInputFiles(path.join(OUT, "quote.pdf"));
  await H.getByText("quote.pdf").waitFor({ timeout: 10000 });
  await H.getByText(/بتاريخ .* · رُفع /).waitFor();
  await shot(page, "c284-2-line-files");
  {
    const dl = page.waitForEvent("download", { timeout: 20000 });
    await H.getByRole("button", { name: "فتح PDF" }).click();
    const f = await dl; if (readFileSync(await f.path()).subarray(0, 5).toString() !== "%PDF-") errors.push("attachment PDF did not open as a PDF");
  }
  await H.getByRole("button", { name: /إغلاق|Close/ }).first().click();
  await H.getByRole("button", { name: "المرفقات (1)" }).waitFor();
  await H.getByRole("button", { name: "سجلّ الأسعار" }).first().click();
  await H.getByText(/عرض سعر مرفق/).waitFor();
  await H.getByText(/تقدير — مراجعة 1 · أسمنت عطبرة/).waitFor();
  await shot(page, "c284-3-price-history");
  await H.getByRole("button", { name: /إغلاق|Close/ }).first().click();
  await H.getByRole("tab", { name: "الحركات" }).click();
  await H.getByRole("button", { name: "حركة جديدة" }).click();
  await H.getByLabel("المبلغ", { exact: true }).fill("1210");
  await H.getByLabel("الوصف", { exact: true }).fill("إسمنت - دفعة أولى");
  await H.locator('select[aria-label="البند"]').selectOption({ index: 1 });
  await H.getByLabel("الكمّيّة (اختياري)").fill("110");
  await H.getByLabel("الوحدة", { exact: true }).fill("كيس");
  await H.getByLabel(/إيصال أو فاتورة مورّد/).setInputFiles(path.join(OUT, "receipt.png"));
  await shot(page, "p5-entry-sheet");
  await H.getByRole("button", { name: "حفظ" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "p5b-after-save");
  console.log("alerts after save:", JSON.stringify(await H.locator('[role="alert"]').allInnerTexts()));
  await H.getByText("إسمنت - دفعة أولى").first().waitFor({ timeout: 10000 });
  await H.getByText(/11\.00.* للوحدة/).first().waitFor();                                 // 1,210 ÷ 110 bags
  await H.getByRole("button", { name: "المرفقات (1)" }).waitFor();
  await shot(page, "p6-ledger");
  await H.getByRole("tab", { name: "الأعضاء" }).click();
  await H.getByRole("button", { name: "إنشاء رمز دعوة" }).click();
  await H.getByText("انسخ الرمز الآن").waitFor({ timeout: 10000 });
  await shot(page, "p7-people-invite");
  await H.getByRole("tab", { name: "الملخّص" }).click();
  await H.getByText("التقدير مقابل الفعلي").waitFor({ timeout: 10000 });
  await shot(page, "p8-overview-charts");
  {
    const dl = page.waitForEvent("download", { timeout: 60000 });
    await H.getByRole("button", { name: "تقرير PDF" }).click();
    const f = await dl; const b = readFileSync(await f.path());
    if (b.subarray(0, 5).toString() !== "%PDF-") errors.push("project report is not a PDF");
    await f.saveAs(path.join(OUT, "c284-project-report.pdf"));
  }
  await ctx.close();
}

const realErrors = errors.filter((e) => !/Blocked|ERR_|Failed to load/.test(e));
console.log("projects-ui:", realErrors.length ? "FAILED\n" + realErrors.join("\n") : "ok");
await browser.close(); server.close();
process.exitCode = realErrors.length ? 1 : 0;
