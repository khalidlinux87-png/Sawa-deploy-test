// Renders an invoice to one self-contained HTML page (no external requests), ready for PDF.
// The input is the stored invoice plus the totals from computeInvoice(). The template does no math.
import { fromMinor } from "./pfm-core.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const L = {
  ar: { invoice: "فاتورة", no: "رقم الفاتورة", issued: "تاريخ الإصدار", due: "تاريخ الاستحقاق", from: "من", to: "إلى", taxId: "الرقم الضريبيّ",
        desc: "الوصف", qty: "الكمّيّة", price: "سعر الوحدة", disc: "الخصم", tax: "الضريبة", amount: "المبلغ قبل الضريبة",
        subtotal: "المجموع الفرعيّ", discount: "خصم الفاتورة", taxOn: "ضريبة القيمة المضافة", total: "الإجماليّ", paid: "المدفوع", balance: "المستحقّ",
        payWith: "ادفع بمحفظة سوا", scan: "امسح الرمز أو افتح الرابط", notes: "ملاحظات",
        status: { draft: "مسوّدة", sent: "مُرسلة", paid: "مدفوعة", overdue: "متأخّرة", cancelled: "ملغاة" } },
  en: { invoice: "Invoice", no: "Invoice no.", issued: "Issue date", due: "Due date", from: "From", to: "Bill to", taxId: "Tax ID",
        desc: "Description", qty: "Qty", price: "Unit price", disc: "Discount", tax: "Tax", amount: "Amount (excl. tax)",
        subtotal: "Subtotal", discount: "Invoice discount", taxOn: "VAT", total: "Total", paid: "Paid", balance: "Balance due",
        payWith: "Pay with Sawa Wallet", scan: "Scan the code or open the link", notes: "Notes",
        status: { draft: "Draft", sent: "Sent", paid: "Paid", overdue: "Overdue", cancelled: "Cancelled" } },
};

/** inv: { number, lang, issueDate, dueDate, status, issuer{name,contact,taxId,address}, client{...}, items[], notes, payUrl }
 *  totals: computeInvoice() output.  qrSvg: optional inline SVG of the pay link. */
export function renderInvoiceHtml(inv, totals, qrSvg = "") {
  const lang = inv.lang === "en" ? "en" : "ar", t = L[lang], cur = totals.currency;
  const money = (m) => `<span class="num">${esc(fmt(m, cur, lang))}</span>`;
  const pct = (bp) => (bp / 100).toFixed(bp % 100 ? 2 : 0) + "%";
  const party = (p, label) => `<div class="party"><div class="lbl">${t[label]}</div><div class="nm">${esc(p.name)}</div>
    ${p.contact ? `<div>${esc(p.contact)}</div>` : ""}${p.address ? `<div>${esc(p.address)}</div>` : ""}
    ${p.taxId ? `<div class="muted">${t.taxId}: <span class="num">${esc(p.taxId)}</span></div>` : ""}</div>`;
  const rows = totals.lines.map((l) => {
    const it = inv.items[l.index];
    return `<tr><td class="d">${esc(it.description)}</td><td class="num">${esc(fromQty(l.qtyMilli))}</td><td>${money(it.unitPrice)}</td>
      <td>${l.lineDiscount ? money(-l.lineDiscount) : "—"}</td><td class="num">${l.taxBp ? pct(l.taxBp) : "—"}</td><td>${money(l.amount)}</td></tr>`;
  }).join("");
  const taxRows = totals.taxBreakdown.map((b) => `<tr><td>${t.taxOn} ${pct(b.taxBp)}</td><td>${money(b.tax)}</td></tr>`).join("");
  return `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<title>${esc(t.invoice + " " + inv.number)}</title><style>
@page{size:A4;margin:16mm 14mm}
*{box-sizing:border-box}body{margin:0;font:10.5pt/1.5 "Noto Naskh Arabic","Noto Sans Arabic","Noto Sans","DejaVu Sans",sans-serif;color:#1a1d21}
.num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums}
header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f766e;padding-bottom:10px}
h1{margin:0;font-size:22pt;color:#0f766e}.meta div{display:flex;gap:10px;justify-content:space-between}.muted,.lbl{color:#5b6470}
.badge{display:inline-block;padding:1px 10px;border-radius:10px;font-size:9pt;background:#e6f4f1;color:#0f766e}
.badge.overdue{background:#fdecec;color:#b42318}.badge.paid{background:#e7f6ea;color:#1e7b34}.badge.cancelled{background:#eee;color:#555}
.parties{display:flex;gap:24px;margin:16px 0}.party{flex:1}.nm{font-weight:700;font-size:12pt}
table.items{width:100%;border-collapse:collapse}table.items th{background:#f2f5f7;font-weight:600;text-align:start;padding:6px}
table.items td{padding:6px;border-bottom:1px solid #e3e7ea;vertical-align:top}table.items td:not(.d),table.items th:not(:first-child){text-align:end;white-space:nowrap}
tr{break-inside:avoid}thead{display:table-header-group}
.bottom{display:flex;gap:24px;margin-top:14px;justify-content:space-between;align-items:flex-start}
table.sum{border-collapse:collapse;min-width:45%;margin-inline-start:auto}table.sum td{padding:4px 6px}table.sum td:last-child{text-align:end}
table.sum tr.total td{font-weight:700;font-size:12.5pt;border-top:2px solid #1a1d21}table.sum tr.due td{color:#0f766e;font-weight:700}
.pay{display:flex;gap:10px;align-items:center;border:1px solid #cfe7e2;border-radius:8px;padding:8px}.pay svg{width:84px;height:84px}
.notes{margin-top:16px;white-space:pre-wrap}
</style></head><body>
<header><div><h1>${t.invoice}</h1><span class="badge ${esc(inv.status)}">${t.status[inv.status] || ""}</span></div>
<div class="meta"><div><span>${t.no}</span><b class="num">${esc(inv.number)}</b></div><div><span>${t.issued}</span><span class="num">${esc(inv.issueDate)}</span></div>
<div><span>${t.due}</span><span class="num">${esc(inv.dueDate)}</span></div></div></header>
<section class="parties">${party(inv.issuer, "from")}${party(inv.client, "to")}</section>
<table class="items"><thead><tr><th>${t.desc}</th><th>${t.qty}</th><th>${t.price}</th><th>${t.disc}</th><th>${t.tax}</th><th>${t.amount}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bottom">${inv.payUrl && inv.status !== "paid" && inv.status !== "cancelled" ? `<div class="pay">${qrSvg}<div><b>${t.payWith}</b><div class="muted">${t.scan}</div><div class="num" style="font-size:8.5pt">${esc(inv.payUrl)}</div></div></div>` : "<div></div>"}
<table class="sum"><tr><td>${t.subtotal}</td><td>${money(totals.subtotal)}</td></tr>
${totals.invoiceDiscount ? `<tr><td>${t.discount}</td><td>${money(-totals.invoiceDiscount)}</td></tr>` : ""}${taxRows}
<tr class="total"><td>${t.total}</td><td>${money(totals.total)}</td></tr>
${totals.amountPaid ? `<tr><td>${t.paid}</td><td>${money(-totals.amountPaid)}</td></tr><tr class="due"><td>${t.balance}</td><td>${money(totals.amountDue)}</td></tr>` : ""}</table></div>
${inv.notes ? `<div class="notes"><div class="lbl">${t.notes}</div>${esc(inv.notes)}</div>` : ""}
</body></html>`;
}

function fmt(minor, cur, lang) {
  const [w, f] = fromMinor(Math.abs(minor), cur).split(".");
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sym = { SDG: lang === "ar" ? "ج.س" : "SDG" }[cur] || cur;
  return (minor < 0 ? "−" : "") + grouped + (f ? "." + f : "") + " " + sym;
}
const fromQty = (m) => (m % 1000 ? (m / 1000).toFixed(3).replace(/0+$/, "") : String(m / 1000));
