// Browser check of the Accountant UI: real app files (joined parts), real Worker op code (Node side), in-memory Firestore.
// Usage: node pfm/ui-check.mjs <path to Sawa-app> <dir with node_modules/react@18.3.1 and react-dom@18.3.1> <screenshot dir>
// Needs Playwright with Chromium. The CDNs are replaced by local React and an empty Firebase, so it runs offline.
import { createRequire } from "module";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { handlePfmOp } = await import("./pfm-worker.mjs");
const { makeFs, ROOT } = await import("./fake-firestore.mjs");

const APP = path.resolve(process.argv[2] || "../Sawa-app"), NM = path.resolve(process.argv[3] || "."), OUT = path.resolve(process.argv[4] || ".");
const src = readFileSync(new URL("../worker-3.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf("function " + name + "("); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return src.slice(a, i + 1); };
const { toFsValue, fsToJs } = new Function(grab("toFsValue") + grab("fsToJs") + "; return { toFsValue, fsToJs };")();
const fs = makeFs(toFsValue, fsToJs);
const d = { DOC_ROOT: ROOT, toFsValue, fsToJs, getToken: async () => "t", fsGet: fs.fsGet, fsList: fs.fsList, fsQuerySub: fs.fsQuerySub, fsCommit: (...a) => fs.fsCommit(...a) };
const env = { PFM_KEK_v1: Buffer.from(new Uint8Array(32).fill(3)).toString("base64") };
const op = (o, p) => handlePfmOp(o, "u1", p, env, d);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
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
  await add("s7", "expense", "25", "c_food", "2026-11-06", { currency: "EUR" });
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
  // edit the EUR entry that is waiting for a rate
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

// ── Wallet entry point: the real WalletScreen lists the service and opens the accountant ──
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ar-SA", timezoneId: "Europe/Berlin" });
  await ctx.route("https://unpkg.com/react@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react/umd/react.production.min.js"), contentType: "text/javascript" }));
  await ctx.route("https://unpkg.com/react-dom@18.3.1/**", (r) => r.fulfill({ path: path.join(NM, "node_modules/react-dom/umd/react-dom.production.min.js"), contentType: "text/javascript" }));
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
