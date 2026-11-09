// Dev-only: the reader's OCR engine in Node (tesseract.js + jpeg-js), for reader-eval.mjs. The app uses the same
// engine in a Web Worker. Set up once in a scratch folder:  npm i tesseract.js@5.1.1 wasm-feature-detect@1.6.1 jpeg-js@0.4.4 @tesseract.js-data/ara @tesseract.js-data/eng
// and run with NODE_PATH pointing at its node_modules.
import { createRequire } from "node:module";
import fs from "node:fs"; import path from "node:path";
const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), "x.js"));
const { createWorker, PSM } = require("tesseract.js");
const jpeg = require("jpeg-js");

export const decode = (file) => jpeg.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });

export async function makeOcr() {
  const base = path.dirname(require.resolve("@tesseract.js-data/ara/package.json"));
  const langPath = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tess-"));
  for (const l of ["ara", "eng"]) fs.copyFileSync(path.join(base, "..", l, "4.0.0_best_int", `${l}.traineddata.gz`), path.join(langPath, `${l}.traineddata.gz`));
  const opts = { langPath, cachePath: langPath, gzip: true };
  const w = { mix: await createWorker(["ara", "eng"], 1, opts), ara: await createWorker("ara", 1, opts),
              eng: await createWorker("eng", 1, opts), num: await createWorker("eng", 1, opts) };
  for (const k of ["mix", "ara", "eng"]) await w[k].setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  await w.num.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: "0123456789,.:-/ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" });
  // mode: "mix" (Arabic + English), "ara", "eng", or "num" (English, digits and month names only)
  const ocr = async (crop, mode) => {
    const buf = jpeg.encode({ width: crop.width, height: crop.height, data: Buffer.from(crop.data.buffer) }, 95).data;
    const { data } = await (w[mode] || w.mix).recognize(buf);
    const lines = data.lines.filter((l) => l.text.trim()).map((l) => ({ text: l.text.trim(), conf: l.confidence, y0: l.bbox.y0, y1: l.bbox.y1 }));
    return { text: lines.map((l) => l.text).join(" "), conf: data.confidence, lines };
  };
  ocr.close = async () => { for (const k in w) await w[k].terminate(); };
  return ocr;
}
