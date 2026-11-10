// Server-side PDF for invoices and the project report (C287).
//
// Why this changed: the first version (C266) imported "@cloudflare/puppeteer", which is not installed in this repo,
// read the logo from an R2 key that is never written (logos live in Firestore), and was never wired to an op.
// "Print or PDF" in the app therefore printed a hidden frame, and Android's WebView and iOS's WKWebView ignore
// window.print(): in the Sawa apps the button did nothing.
//
// Now the Worker asks Cloudflare Browser Rendering for the PDF over its REST API (a plain fetch, no package, no binding).
// It needs two Worker secrets:
//   CF_ACCOUNT_ID   the Cloudflare account id
//   CF_BR_TOKEN     an API token with "Browser Rendering: Edit"
// Without them pdfAvailable() is false and the app builds the PDF on the phone from the same HTML (pfmPdf in app.p9.js).
// The HTML is self-contained (data: logo, no scripts, no fonts from the network), and every other request is refused,
// so the renderer cannot be pointed at anything else.

const API = (acct) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acct)}/browser-rendering/pdf`;
export const PDF_MAX = 8 * 1024 * 1024;

export const pdfAvailable = (env) => !!(env && env.CF_ACCOUNT_ID && env.CF_BR_TOKEN);

const escTpl = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// html -> PDF bytes (Uint8Array). footer: short plain text printed at the bottom of each page with "page/pages".
export async function htmlToPdf(env, html, { footer = "", fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  if (!pdfAvailable(env)) throw new Error("pdf_unavailable");
  const body = {
    html,
    rejectRequestPattern: ["^(?!data:).*"],     // only data: URIs load; the template needs nothing else
    gotoOptions: { waitUntil: "load", timeout: timeoutMs },
    pdfOptions: {
      format: "a4", printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:7pt;width:100%;text-align:center;color:#888;font-family:sans-serif"><span dir="ltr">${escTpl(footer)}${footer ? " · " : ""}<span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
    },
  };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs + 5000) : null;
  let r;
  try {
    r = await fetchImpl(API(env.CF_ACCOUNT_ID), { method: "POST", headers: { Authorization: "Bearer " + env.CF_BR_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined });
  } finally { if (timer) clearTimeout(timer); }
  const type = (r.headers.get("content-type") || "").toLowerCase();
  if (!r.ok || !type.includes("application/pdf")) {
    let why = "status " + r.status;
    try { const j = await r.json(); if (j && j.errors && j.errors[0]) why += " " + String(j.errors[0].message || j.errors[0].code).slice(0, 80); } catch (e) { /* not JSON */ }
    throw new Error("pdf_failed: " + why);
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length < 16 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) throw new Error("pdf_failed: not a PDF");
  if (bytes.length > PDF_MAX) throw new Error("pdf_failed: too big");
  return bytes;
}

export function toBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// A safe file name for the download: letters, digits, dash, underscore and dot only.
export const pdfName = (stem) => (String(stem || "invoice").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "invoice") + ".pdf";
