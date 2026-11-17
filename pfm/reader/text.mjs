// Sawa reader — text helpers shared by every template (IMPORT-DESIGN.md §4.2, §5).

const AR_DIGITS = /[٠-٩۰-۹]/g;
export const westernDigits = (s) => String(s ?? "").replace(AR_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));

/** Arabic letters unified for matching and search: أإآٱ→ا, ة→ه, ى→ي, ؤ→و, ئ→ي; no diacritics or tatweel. */
export function normAr(s) {
  return westernDigits(s).normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function levenshtein(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= n; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[n];
}

/** Best label for an OCR'd label text, or null. `labels`: {fieldName: [variants…]}. */
export function matchLabel(text, labels, minScore = 0.75) {
  const t = normAr(text).replace(/\s+/g, "");
  if (!t) return null;
  let best = null;
  for (const [field, variants] of Object.entries(labels)) for (const v of variants) {
    const u = normAr(v).replace(/\s+/g, "");
    const score = 1 - levenshtein(t, u) / Math.max(t.length, u.length);
    if (score >= minScore && (!best || score > best.score)) best = { field, score, variant: v };
  }
  return best;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** UTC offset ("+02:00") of an IANA zone at a local date and time. */
export function offsetOf(tz, y, mo, d, h, mi) {
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at);
  const o = (p.find((x) => x.type === "timeZoneName") || {}).value || "GMT";
  return o === "GMT" ? "+00:00" : o.slice(3);
}

/** "02-Nov-2026 14:02:10" → "2026-11-02T14:02:10+02:00" in `tz`, or null if it is not a real date and time. */
export function parseDmyMon(text, tz) {
  const m = westernDigits(text).match(/(\d{1,2})[-\s/]([A-Za-z]{3})[-\s/](\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss] = m, mo = MONTHS[mon.toLowerCase()];
  const d = +dd, y = +yyyy, h = +hh;
  if (!mo || d < 1 || h > 23 || +mi > 59 || +ss > 59) return null;
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (real.getUTCMonth() !== mo - 1) return null;
  const p2 = (v) => String(v).padStart(2, "0");
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${mi}:${ss}${offsetOf(tz, y, mo, d, h, +mi)}`;
}

/**
 * Money as printed → canonical decimal string with `decimals` places ("50,000.00" → "50000.00", "200000.0" → "200000.00"),
 * or null if the shape is not trusted. `minDecimals` allows screens that print fewer places (Bankak bill payments: one).
 */
export function parseMoney(text, { decimals = 2, minDecimals = decimals } = {}) {
  const s = westernDigits(text).replace(/[٬]/g, ",").replace(/٫/g, ".").replace(/\s+/g, "");
  const re = new RegExp(`^(\\d{1,3}(?:,\\d{3})+|\\d+)\\.(\\d{${minDecimals},${decimals}})$`);
  const m = s.match(re);
  return m ? `${m[1].replace(/,/g, "")}.${m[2].padEnd(decimals, "0")}` : null;
}

/** Digits only, in groups as printed; `groups` = expected group sizes, e.g. [4,4,4,4]. */
export function parseGrouped(text, groups) {
  const digits = westernDigits(text).replace(/[^0-9]/g, "");
  const want = groups.reduce((a, b) => a + b, 0);
  if (digits.length !== want) return null;
  let i = 0; return groups.map((g) => digits.slice(i, (i += g))).join(" ");
}

export const isNA = (s) => /^\s*(n\s*\/?\s*a|-+|غير متوفر|لا يوجد)\s*$/i.test(String(s ?? ""));

/** Drops stray one-character marks OCR picks up from cell edges ("| 50,000.00", "20000000001 j"). Never touches digits. */
export const cleanEdges = (s) => String(s ?? "").replace(/^\s*(?:[|!lIj\]\[)(]\s+)+/, "").replace(/(?:\s+[|!lIj\]\[)(])+\s*$/, "").trim();
