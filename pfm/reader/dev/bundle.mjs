// Builds the app's copy of the reader into Sawa-app/ocr/sawa-reader-<VERSION>.js and the OCR engine files into Sawa-app/ocr/v1/.
// Usage: NODE_PATH=<scratch>/node_modules node pfm/reader/dev/bundle.mjs ../Sawa-app/ocr/v1
// (scratch needs: esbuild tesseract.js@5.1.1 tesseract.js-core @tesseract.js-data/ara @tesseract.js-data/eng)
// Phones cache everything under /ocr/ for good: the reader file carries its version in its name (browser.mjs VERSION,
// bump it with every change), and a new engine would go in a new folder (v2).
import { createRequire } from "node:module";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), "x.js"));
const esbuild = require("esbuild");
const out = path.resolve(process.argv[2] || "ocr/v1"); fs.mkdirSync(out, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({ entryPoints: [path.join(here, "..", "browser.mjs")], bundle: true, format: "iife", globalName: "SawaReader",
  target: "es2020", minify: true, legalComments: "none", outfile: path.join(out, "..", `sawa-reader-${(await import(path.join(here, "..", "browser.mjs"))).VERSION}.js`),
  banner: { js: "/* Sawa receipt reader — built from Sawa-deploy-test/pfm/reader (dev/bundle.mjs). Do not edit here. */" } });
const dir = (p) => path.dirname(require.resolve(p + "/package.json"));
const copy = (from, name) => fs.copyFileSync(from, path.join(out, name || path.basename(from)));
copy(path.join(dir("tesseract.js"), "dist", "tesseract.min.js"));
copy(path.join(dir("tesseract.js"), "dist", "worker.min.js"));
for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) copy(path.join(dir("tesseract.js-core"), f));
for (const l of ["ara", "eng"]) copy(path.join(dir("@tesseract.js-data/" + l), "4.0.0_best_int", l + ".traineddata.gz"));
for (const f of fs.readdirSync(path.join(out, ".."))) { const p = path.join(out, "..", f); if (fs.statSync(p).isFile()) console.log(String(fs.statSync(p).size).padStart(9), f); }
