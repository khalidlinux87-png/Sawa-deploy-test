// Template: Bankak (بنكك), the Bank of Khartoum app. Written from 7 real screenshots (2026-11-09), kept in the private
// samples repository, never here. Four layouts, all a two-column table of label | value:
//   success_en  green "Funds Transfer" screen after a transfer      (Trx. ID, Date & Time, From Account, To Account, To Account Title, Mobile Number, Comment, Amount)
//   success_ar  green «تحويلات» screen, same rows in Arabic           (often scrolled: the first rows can be cut off)
//   details_en  white "Transaction Details" from the history         (adds Trx. type and Status; From / To)
//   details_ar  white «تفاصيل المعاملة», same rows in Arabic
// Facts used (not guesses): Bankak transfers are in Sudanese pounds (the screen's transfer button reads "SDG");
// the time shown is Sudan time (Africa/Khartoum); account numbers are 16 digits in four groups ending in 0001;
// amounts have 2 decimals. Income or spending follows sender and recipient.

export default {
  id: "bankak",
  version: 3,
  name: { ar: "بنكك (بنك الخرطوم)", en: "Bankak (Bank of Khartoum)" },
  currency: "SDG",
  tz: "Africa/Khartoum",
  minLabels: 4,                      // a screenshot is Bankak when at least this many of its labels are found
  labels: {
    transaction_id: ["Trx. ID", "Trx ID", "رقم العملية"],
    timestamp: ["Date & Time", "التاريخ والوقت", "التاريخ و الزمن", "التاريخ والزمن"],
    from_account: ["From Account", "From", "من حساب", "من"],
    to_account: ["To Account", "To", "الى حساب", "إلى حساب", "إلى", "الى"],
    to_name: ["To Account Title", "إسم المرسل اليه", "اسم المرسل اليه", "إسم المرسل إليه"],
    mobile: ["Mobile Number", "رقم الموبايل"],
    note: ["Comment", "التعليق"],
    amount: ["Amount", "المبلغ"],
    trx_type: ["Trx. type", "Trx type", "نوع العملية"],
    bill_id: ["مُعرف الفاتورة", "معرف الفاتورة", "Bill ID", "Bill Identifier"],
    status: ["Status", "الحالة"],
  },
  // How each value is read: "num" = digits (English OCR, no right-to-left reordering), "text" = Arabic and English.
  read: { transaction_id: "num", timestamp: "num", from_account: "num", to_account: "num", amount: "num", mobile: "num",
          to_name: "text", note: "text", trx_type: "text", status: "text", bill_id: "num" },
  parse: {
    transaction_id: { pattern: /^\d{8,16}$/ },
    account: { groups: [4, 4, 4, 4], suffix: "0001" },   // Bankak accounts always end in 0001 (confirmed by Khalid, 2026-11-09)
    amount: { decimals: 2, minDecimals: 1 },            // bill payments print one decimal: 200000.0
    timestamp: { format: "DD-Mon-YYYY HH:mm:ss" },
  },
  // Labels that appear only on the green success screen, which only the sender sees: its From account is the user's.
  senderOnly: ["From Account", "من حساب"],
  // A bill payment always goes out of the user's own account; «إلى» then names the biller (e.g. ايصالي), not an account.
  billTypes: ["سداد فاتورة", "Bill Payment"],
  // Billers seen on Bankak bill payments. A biller name read close to one of these is snapped to it (OCR drops letters
  // from short Arabic words: «يصال» for «ايصالي»). Add new billers here as samples show them.
  billers: ["ايصالي"],
  success: ["Success", "نجاح"],
  // Words that mean the money did not move: a Status reading like one of these flags the row. Unreadable junk does not
  // (the success word is short and OCR sometimes turns it into Latin noise).
  failure: ["فشل", "فاشلة", "مرفوضة", "مرفوض", "ملغاة", "معلقة", "قيد التنفيذ", "Failed", "Failure", "Rejected", "Pending", "Cancelled", "Reversed"],     // a Status row with anything else is flagged: a failed transfer is not money spent
  serviceType: "bank_transfer",
};
