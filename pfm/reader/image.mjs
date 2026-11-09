// Sawa reader — image steps (IMPORT-DESIGN.md §4.3). Pure JavaScript on RGBA pixels ({width, height, data}),
// so the same code runs in the app (canvas ImageData) and in Node (decoded JPEG/PNG). No OCR here.

const lumAt = (img, x, y) => { const i = (y * img.width + x) * 4, d = img.data; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };

/** y positions of horizontal ruled lines (cell borders) that cross most of the screen. */
export function findRules(img, { minSpan = 0.8, contrast = 20, gap = 3 } = {}) {
  const { width: W, height: H } = img, x0 = Math.round(W * 0.2), x1 = Math.round(W * 0.8), ys = [];
  for (let y = gap; y < H - gap; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      const l = lumAt(img, x, y);
      if (Math.abs(l - lumAt(img, x, y - gap)) > contrast && Math.abs(l - lumAt(img, x, y + gap)) > contrast) n++;
    }
    if (n / (x1 - x0) >= minSpan) ys.push(y);
  }
  const runs = [];
  for (const y of ys) { const r = runs[runs.length - 1]; if (r && y - r[1] <= gap) r[1] = y; else runs.push([y, y]); }
  return runs.map(([a, b]) => (a + b) >> 1);
}

/** Background luminance of a region: the most common value (bucketed). */
function background(img, x0, y0, x1, y1) {
  const h = new Uint32Array(64);
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) h[Math.min(63, lumAt(img, x, y) >> 2)]++;
  let best = 0; for (let i = 1; i < 64; i++) if (h[i] > h[best]) best = i;
  return best * 4 + 2;
}

/**
 * Table cells: the bands between consecutive rules that hold text and look like a table row.
 * Each cell is split into its two halves (label and value) at the widest empty column gap.
 */
export function findCells(img, opts = {}) {
  const rules = findRules(img, opts), bands = [];
  for (let i = 1; i < rules.length; i++) bands.push([rules[i - 1], rules[i]]);
  const hs = bands.map(([a, b]) => b - a).filter((h) => h >= 30).sort((a, b) => a - b);
  const median = hs.length ? hs[hs.length >> 1] : 0, out = [];
  for (const [a, b] of bands) {
    const h = b - a;
    if (h < 30 || h > median * 2.2) continue;                       // gaps between cells, or big blocks (buttons, footers)
    const y0 = a + 4, y1 = b - 4, bg = background(img, 0, y0, img.width, y1);
    const ink = new Uint16Array(img.width);
    for (let x = 0; x < img.width; x++) for (let y = y0; y < y1; y++) if (Math.abs(lumAt(img, x, y) - bg) > 60) ink[x]++;
    // The cell's vertical borders (columns inked through most of the height, near either edge) and everything
    // outside them are not text; otherwise border pixels are read as "|", "l" or "ض".
    const tall = (x) => ink[x] >= (y1 - y0) * 0.5;
    let lo = 0, hi = img.width - 1;
    for (let x = 0; x < img.width * 0.15; x++) if (tall(x)) lo = x + 6;
    for (let x = img.width - 1; x > img.width * 0.85; x--) if (tall(x)) hi = x - 6;
    const isText = (x) => x >= lo && x <= hi && ink[x] > 0 && !tall(x);
    let first = -1, last = -1;
    for (let x = lo; x <= hi; x++) if (isText(x)) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    let gx0 = -1, gx1 = -1, run = 0;
    for (let x = first; x <= last; x++) {
      if (!isText(x)) { run++; if (run > gx1 - gx0) { gx1 = x; gx0 = x - run + 1; } } else run = 0;
    }
    const minGap = img.width * 0.04;
    const box = (x0, x1) => ({ x: Math.max(lo, x0 - 5), y: y0, w: Math.min(hi + 1, x1 + 6) - Math.max(lo, x0 - 5), h: y1 - y0 });
    if (gx0 < 0 || gx1 - gx0 < minGap) { out.push({ y: a, h, whole: box(first, last), left: null, right: null, bg }); continue; }
    out.push({ y: a, h, left: box(first, gx0 - 1), right: box(gx1 + 1, last), bg });
  }
  return out;
}

/**
 * Crop for OCR: grey, dark text on white, scaled up so text is ~30 px high.
 * Returns RGBA pixels the caller encodes for its OCR engine.
 */
export function prepCrop(img, { x, y, w, h }, bg, scale = 2) {
  const invert = bg < 128, W = w * scale, H = h * scale, data = new Uint8ClampedArray(W * H * 4);
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    let l = lumAt(img, x + Math.min(w - 1, Math.floor(xx / scale)), y + Math.min(h - 1, Math.floor(yy / scale)));
    if (invert) l = 255 - l;
    const i = (yy * W + xx) * 4; data[i] = data[i + 1] = data[i + 2] = l; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}
