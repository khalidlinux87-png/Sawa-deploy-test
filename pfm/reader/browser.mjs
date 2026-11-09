// Browser entry of the Sawa reader, bundled into Sawa-app/ocr/v1/sawa-reader.js (global SawaReader) by dev/bundle.mjs.
// OCR runs on the phone with tesseract.js, served from the app's own origin (/ocr/v1/), never a CDN.
import { readImage, recomputeKind, extractFromCells } from "./extract.mjs";
import bankak from "./templates/bankak.mjs";

export const templates = [bankak];
export { readImage, recomputeKind, extractFromCells };
export const VERSION = "1";

/** Load tesseract.min.js once. */
function loadScript(src) {
  if (globalThis.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("ocr_load_failed")); document.head.appendChild(s); });
}

/**
 * The OCR engine for readImage: one tesseract.js worker per mode, each created on first use.
 * onProgress(text) reports the one-time download of the engine and language models.
 */
export async function makeOcr({ base = "/ocr/v1/", onProgress } = {}) {
  await loadScript(base + "tesseract.min.js");
  const T = globalThis.Tesseract, made = {};
  const langs = { mix: ["ara", "eng"], ara: "ara", eng: "eng", num: "eng" };
  const opts = { workerPath: base + "worker.min.js", corePath: base, langPath: base.replace(/\/$/, ""), gzip: true, workerBlobURL: false,
    logger: (m) => { if (onProgress && m && /loading/.test(m.status || "")) onProgress(m.status, m.progress); } };
  const get = (mode) => (made[mode] ||= (async () => {
    const w = await T.createWorker(langs[mode], 1, opts);
    await w.setParameters(mode === "num"
      ? { tessedit_pageseg_mode: "6", tessedit_char_whitelist: "0123456789,.:-/ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" }
      : { tessedit_pageseg_mode: "6" });
    return w;
  })());
  const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { willReadFrequently: true });
  const ocr = async (crop, mode) => {
    canvas.width = crop.width; canvas.height = crop.height;
    g.putImageData(new ImageData(crop.data, crop.width, crop.height), 0, 0);
    const { data } = await (await get(mode in langs ? mode : "mix")).recognize(canvas);
    return { text: data.lines.map((l) => l.text.trim()).filter(Boolean).join(" "), conf: data.confidence };
  };
  ocr.warm = () => Promise.all(["mix", "num"].map(get));
  ocr.close = async () => { for (const k of Object.keys(made)) (await made[k]).terminate(); };
  return ocr;
}

/** A picked image file → RGBA pixels, at most `maxSide` px on the long side (screenshots stay as they are). */
export function pixelsOf(file, maxSide = 1800) {
  return new Promise((res, rej) => {
    const img = document.createElement("img"), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, maxSide / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      res(g.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("bad_image")); };
    img.src = url;
  });
}

/** Read one file with every template; null when no template recognises it. */
export async function readFile(file, ocr, ctx) {
  return readImage(await pixelsOf(file), ocr, templates, ctx);
}
