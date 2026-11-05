// Worker side of PDF export: invoice -> totals -> HTML -> PDF (Cloudflare Browser Rendering) -> R2 cache -> signed link.
// Needs these wrangler.toml bindings (not added yet; create the bucket first):
//   browser = { binding = "BROWSER" }
//   [[r2_buckets]] binding = "PFM_FILES"  bucket_name = "sawa-pfm-files"
// and the secret PFM_LINK_KEY (HMAC key for download links).
import puppeteer from "@cloudflare/puppeteer";
import { computeInvoice, canonical } from "./pfm-core.mjs";
import { renderInvoiceHtml } from "./invoice-html.mjs";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function invoicePdf(env, inv, { qrSvg = "" } = {}) {
  // 1. Recompute the totals on the server. Stored totals are never trusted for output.
  const totals = computeInvoice(inv.items, { currency: inv.currency, invoiceDiscount: inv.invoiceDiscount, taxInclusive: inv.taxInclusive, amountPaid: inv.amountPaid });
  // 2. The content hash is the cache key. A status change or a payment gives a new file.
  //    The same invoice in the same state reuses the stored PDF and never starts a browser.
  const html = renderInvoiceHtml(inv, totals, qrSvg);
  const hash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({ v: 1, html }))));
  const key = `invoices/${inv.issuerUid}/${inv.id}/${hash.slice(0, 32)}.pdf`;

  if (!(await env.PFM_FILES.head(key))) {
    // 3. Render. A real browser is needed: it shapes Arabic and lays out RTL text correctly,
    //    which most JS PDF libraries cannot do.
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(false);                       // the template needs no script
      await page.setRequestInterception(true);                      // and must not fetch anything
      page.on("request", (r) => (r.url().startsWith("data:") ? r.continue() : r.abort()));
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true,
        displayHeaderFooter: true, headerTemplate: "<span></span>",
        footerTemplate: `<div style="font-size:7pt;width:100%;text-align:center;color:#888">${inv.number} · <span class="pageNumber"></span>/<span class="totalPages"></span></div>` });
      await env.PFM_FILES.put(key, pdf, {
        httpMetadata: { contentType: "application/pdf", contentDisposition: `inline; filename="invoice-${inv.number}.pdf"` },
        customMetadata: { invoiceId: inv.id, status: inv.status, sha256: hash },
      });
    } finally { await browser.close(); }
  }
  return { key, hash, totals };
}

// Short-lived download link served by GET /pfm/file. The Worker checks the HMAC and expiry, then streams from R2.
// R2 objects are never public.
export async function signedFileUrl(env, origin, key, ttlSec = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PFM_LINK_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(key + "|" + exp)));
  return `${origin}/pfm/file?k=${encodeURIComponent(key)}&e=${exp}&s=${sig}`;
}

export async function serveSignedFile(env, url) {
  const key = url.searchParams.get("k"), exp = Number(url.searchParams.get("e")), sig = url.searchParams.get("s") || "";
  if (!key || !(exp > Date.now() / 1000)) return new Response("expired", { status: 410 });
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PFM_LINK_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", k, Uint8Array.from(sig.match(/../g) || [], (h) => parseInt(h, 16)), new TextEncoder().encode(key + "|" + exp));
  if (!ok) return new Response("forbidden", { status: 403 });
  const obj = await env.PFM_FILES.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers(); obj.writeHttpMetadata(h);
  h.set("Cache-Control", "private, max-age=300"); h.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers: h });
}
