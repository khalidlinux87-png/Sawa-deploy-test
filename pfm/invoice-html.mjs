// Renders an invoice to one self-contained HTML page (no external requests), ready for PDF.
// The input is the stored invoice plus the totals from computeInvoice(). The template does no math.
import { fromMinor } from "./pfm-core.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const L = {
  ar: { invoice: "فاتورة", no: "رقم الفاتورة", issued: "تاريخ الإصدار", due: "تاريخ الاستحقاق", from: "من", to: "إلى", taxId: "الرقم الضريبيّ",
        desc: "الوصف", qty: "الكمّيّة", price: "سعر الوحدة", disc: "الخصم", tax: "الضريبة", amount: "المبلغ قبل الضريبة",
        subtotal: "المجموع الفرعيّ", discount: "خصم الفاتورة", taxOn: "الضريبة", total: "الإجماليّ", paid: "المدفوع", balance: "المستحقّ",
        payWith: "ادفع بمحفظة سوا", payWithCard: "ادفع بمحفظة سوا أو بالبطاقة", viewOnline: "اعرض الفاتورة وأبلغ عن دفعك", scan: "امسح الرمز أو افتح الرابط", notes: "ملاحظات",
        payTo: "طرق الدفع", holder: "اسم صاحب الحساب", acct: "رقم الحساب", branch: "الفرع", ref: "اكتب رقم الفاتورة في خانة البيان",
        status: { draft: "مسوّدة", sent: "مُرسلة", paid: "مدفوعة", overdue: "متأخّرة", cancelled: "ملغاة", partially_paid: "مدفوعة جزئيّاً", pending_verification: "مدفوعة — بانتظار التحقّق" } },
  en: { invoice: "Invoice", no: "Invoice no.", issued: "Issue date", due: "Due date", from: "From", to: "Bill to", taxId: "Tax ID",
        desc: "Description", qty: "Qty", price: "Unit price", disc: "Discount", tax: "Tax", amount: "Amount (excl. tax)",
        subtotal: "Subtotal", discount: "Invoice discount", taxOn: "Tax", total: "Total", paid: "Paid", balance: "Balance due",
        payWith: "Pay with Sawa Wallet", payWithCard: "Pay with Sawa Wallet or card", viewOnline: "View the invoice and report your payment", scan: "Scan the code or open the link", notes: "Notes",
        payTo: "Payment details", holder: "Account holder", acct: "Account no.", branch: "Branch", ref: "Use the invoice number as the payment reference",
        status: { draft: "Draft", sent: "Sent", paid: "Paid", overdue: "Overdue", cancelled: "Cancelled", partially_paid: "Partially paid", pending_verification: "Paid — pending verification" } },
};

/** inv: { number, lang, issueDate, dueDate, status, issuer{name,contact,taxId,address,logoDataUri?}, client{...}, items[], notes, payUrl,
 *         payoutAccounts?: [validatePayoutAccount() output, already decrypted], methods?: payOptions().methods }
 *  totals: computeInvoice() output.  qrSvg: optional inline SVG of the pay link. */
export function renderInvoiceHtml(inv, totals, qrSvg = "") {
  const lang = inv.lang === "en" ? "en" : "ar", t = L[lang], cur = totals.currency;
  const money = (m) => fmt(m, cur, lang);
  const pct = (rate) => esc(rate) + "%";                  // the rate exactly as the issuer typed it ("8.875")
  const taxName = esc(inv.taxLabel || t.taxOn);          // the issuer's own name for the tax: "VAT", "GST", "TVA", …
  const party = (p, label) => `<div class="party"><div class="lbl">${t[label]}</div><div class="nm">${esc(p.name)}</div>
    ${p.contact ? `<div>${auto(p.contact)}</div>` : ""}${p.address ? `<div>${esc(p.address)}</div>` : ""}
    ${p.taxId ? `<div class="muted">${t.taxId}: <span class="num" dir="ltr">${esc(p.taxId)}</span></div>` : ""}</div>`;
  const rows = totals.lines.map((l) => {
    const it = inv.items[l.index];
    return `<tr><td class="d">${esc(it.description)}</td><td><span class="num" dir="ltr">${esc(fromQty(l.qtyMilli))}</span></td><td>${money(it.unitPrice)}</td>
      <td>${l.lineDiscount ? money(-l.lineDiscount) : "—"}</td><td>${l.taxRate !== "0" ? `<span class="num" dir="ltr">${pct(l.taxRate)}</span>` : "—"}</td><td>${money(l.amount)}</td></tr>`;
  }).join("");
  const taxRows = totals.taxBreakdown.map((b) => `<tr><td>${taxName} <span class="num" dir="ltr">${pct(b.taxRate)}</span></td><td>${money(b.tax)}</td></tr>`).join("");
  return `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<title>${esc(t.invoice + " " + inv.number)}</title><style>
@page{size:A4;margin:16mm 14mm}
*{box-sizing:border-box}body{margin:0;font:10.5pt/1.5 "Noto Naskh Arabic","Noto Sans Arabic","Noto Sans","DejaVu Sans",sans-serif;color:#1a1d21}
.num{direction:ltr;unicode-bidi:isolate;display:inline-block;font-variant-numeric:tabular-nums}
header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f766e;padding-bottom:10px}
h1{margin:0;font-size:22pt;color:#0f766e}.meta div{display:flex;gap:10px;justify-content:space-between}.muted,.lbl{color:#5b6470}
.badge{display:inline-block;padding:1px 10px;border-radius:10px;font-size:9pt;background:#e6f4f1;color:#0f766e}
.badge.overdue{background:#fdecec;color:#b42318}.badge.partially_paid,.badge.pending_verification{background:#fff4e0;color:#8a4b00}.badge.paid{background:#e7f6ea;color:#1e7b34}.badge.cancelled{background:#eee;color:#555}
.parties{display:flex;gap:24px;margin:16px 0}.party{flex:1}.nm{font-weight:700;font-size:12pt}
table.items{width:100%;border-collapse:collapse}table.items th{background:#f2f5f7;font-weight:600;text-align:start;padding:6px}
table.items td{padding:6px;border-bottom:1px solid #e3e7ea;vertical-align:top}table.items td:not(.d),table.items th:not(:first-child){text-align:end;white-space:nowrap}
tr{break-inside:avoid}thead{display:table-header-group}
.bottom{display:flex;gap:24px;margin-top:14px;justify-content:space-between;align-items:flex-start}
table.sum{border-collapse:collapse;min-width:45%;margin-inline-start:auto}table.sum td{padding:4px 6px}table.sum td:last-child{text-align:end}
table.sum tr.total td{font-weight:700;font-size:12.5pt;border-top:2px solid #1a1d21}table.sum tr.due td{color:#0f766e;font-weight:700}
.pay{display:flex;gap:10px;align-items:center;border:1px solid #cfe7e2;border-radius:8px;padding:8px}.pay svg{width:84px;height:84px}
.notes{margin-top:16px;white-space:pre-wrap}
.amt{white-space:nowrap}
.brand{display:flex;gap:12px;align-items:center}.brand img{max-height:56px;max-width:140px;object-fit:contain}
.accts{margin-top:16px;break-inside:avoid}.accts .grid{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0}.acct{flex:1 1 30%;min-width:160px;border:1px solid #e3e7ea;border-radius:8px;padding:6px 8px;font-size:9.5pt}.acct b{display:block}.small{font-size:8.5pt}
</style></head><body>
<header><div class="brand">${logo(inv.issuer.logoDataUri)}<div><h1>${t.invoice}</h1><span class="badge ${esc(badgeOf(inv))}">${t.status[badgeOf(inv)] || ""}</span></div></div>
<div class="meta"><div><span>${t.no}</span><b class="num">${esc(inv.number)}</b></div><div><span>${t.issued}</span><span class="num" dir="ltr">${esc(inv.issueDate)}</span></div>
<div><span>${t.due}</span><span class="num" dir="ltr">${esc(inv.dueDate)}</span></div></div></header>
<section class="parties">${party(inv.issuer, "from")}${party(inv.client, "to")}</section>
<table class="items"><thead><tr><th>${t.desc}</th><th>${t.qty}</th><th>${t.price}</th><th>${t.disc}</th><th>${inv.taxLabel ? taxName : t.tax}</th><th>${t.amount}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bottom">${inv.payUrl && payable(inv) ? `<div class="pay">${qrSvg}<div><b>${payLabel(inv.methods || [], t)}</b><div class="muted">${t.scan}</div><div class="num" style="font-size:8.5pt">${esc(inv.payUrl)}</div></div></div>` : "<div></div>"}
<table class="sum"><tr><td>${t.subtotal}</td><td>${money(totals.subtotal)}</td></tr>
${totals.invoiceDiscount ? `<tr><td>${t.discount}</td><td>${money(-totals.invoiceDiscount)}</td></tr>` : ""}${taxRows}
<tr class="total"><td>${t.total}</td><td>${money(totals.total)}</td></tr>
${totals.amountPaid ? `<tr><td>${t.paid}</td><td>${money(-totals.amountPaid)}</td></tr><tr class="due"><td>${t.balance}</td><td>${money(totals.amountDue)}</td></tr>` : ""}</table></div>
${payable(inv) && inv.payoutAccounts?.length ? `<section class="accts"><div class="lbl">${t.payTo}</div><div class="grid">${inv.payoutAccounts.map((a) => acct(a, t)).join("")}</div><div class="muted small">${t.ref}: <b class="num">${esc(inv.number)}</b></div></section>` : ""}
${inv.notes ? `<div class="notes"><div class="lbl">${t.notes}</div>${esc(inv.notes)}</div>` : ""}
</body></html>`;
}

// Phone numbers and emails have no letters that set a direction, so in Arabic a leading "+" would drift to the end.
const auto = (v) => (/[\u0600-\u06FF]/.test(v) ? esc(v) : `<span class="num" dir="ltr">${esc(v)}</span>`);
// The pay-link block names only the ways to pay that are switched on. With wallet and card off,
// the link still lets the client view the invoice and report a transfer.
const payLabel = (m, t) => (m.includes("wallet") ? (m.includes("card") ? t.payWithCard : t.payWith) : t.viewOnline);
// C284: an invoice with money on it shows that state ("Partially paid", "Paid — pending verification"), not just "Sent".
const badgeOf = (inv) => (inv.payState === "partially_paid" || inv.payState === "pending_verification" ? inv.payState : inv.status);
const payable = (inv) => inv.status === "sent" || inv.status === "overdue" || inv.status === "draft";
// Only data: URIs pass, and only raster types (see sniffLogo). The renderer also blocks all network requests.
const logo = (u) => (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u || "") ? `<img src="${u}" alt="">` : "");
function acct(a, t) {
  const row = (k, v, n) => (v ? `<div>${k ? `<span class="muted">${k}: </span>` : ""}${n ? `<span class="num" dir="ltr">${esc(v)}</span>` : esc(v)}</div>` : "");
  if (a.type === "sawa_wallet") return "";               // covered by the pay link block
  return `<div class="acct"><b>${esc(a.bankName || a.provider || a.label)}</b>${row(t.holder, a.holderName)}${row(t.acct, a.number, 1)}${row(t.branch, a.branch)}${row("", a.details)}</div>`;
}

// Any currency: symbol and decimals from Intl for the invoice language. Digits are always Western (latn),
// and the amount is passed as text, so large values are not rounded through a float.
// Returns HTML: the number is an LTR island, and the symbol stays in the page's direction, so Arabic
// symbols with dots (ر.س. د.إ. ج.م.) read correctly and sit on the left of the number as in print.
const fmtCache = new Map();
function fmt(minor, cur, lang) {
  const k = lang + cur;
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.NumberFormat(lang === "ar" ? "ar-u-nu-latn" : "en", { style: "currency", currency: cur, currencyDisplay: lang === "ar" ? "symbol" : "code" }); fmtCache.set(k, f); }
  const parts = f.formatToParts(fromMinor(Math.abs(minor), cur));
  const clean = (x) => x.replace(/[\u200e\u200f\u061c]/g, "").trim();
  const sym = clean(parts.filter((x) => x.type === "currency").map((x) => x.value).join(""));
  const number = clean(parts.filter((x) => x.type !== "currency" && x.type !== "literal").map((x) => x.value).join(""));
  const n = `<span class="num" dir="ltr">${minor < 0 ? "−" : ""}${esc(number)}</span>`;
  return lang === "ar" ? `<span class="amt">${n} ${esc(sym)}</span>` : `<span class="amt">${esc(sym)} ${n}</span>`;
}
const fromQty = (m) => (m % 1000 ? (m / 1000).toFixed(3).replace(/0+$/, "") : String(m / 1000));
