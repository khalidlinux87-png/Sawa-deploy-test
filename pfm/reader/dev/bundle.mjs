// Builds the app's copy of the reader and its OCR files into Sawa-app/ocr/v1/.
// Usage: NODE_PATH=<scratch>/node_modules node pfm/reader/dev/bundle.mjs ../Sawa-app/ocr/v1
// (scratch needs: esbuild tesseract.js@5.1.1 tesseract.js-core @tesseract.js-data/ara @tesseract.js-data/eng)
// A new reader version goes in a new folder (v2…), so phones never mix an old engine with a new reader.
import { createRequire } from "node:module";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), "x.js"));
const esbuild = require("esbuild");
const out = path.resolve(process.argv[2] || "ocr/v1"); fs.mkdirSync(out, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({ entryPoints: [path.join(here, "..", "browser.mjs")], bundle: true, format: "iife", globalName: "SawaReader",
  target: "es2020", minify: true, legalComments: "none", outfile: path.join(out, "sawa-reader.js"),
  banner: { js: "/* Sawa receipt reader — built from Sawa-deploy-test/pfm/reader (dev/bundle.mjs). Do not edit here. */" } });
const dir = (p) => path.dirname(require.resolve(p + "/package.json"));
const copy = (from, name) => fs.copyFileSync(from, path.join(out, name || path.basename(from)));
copy(path.join(dir("tesseract.js"), "dist", "tesseract.min.js"));
copy(path.join(dir("tesseract.js"), "dist", "worker.min.js"));
for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) copy(path.join(dir("tesseract.js-core"), f));
for (const l of ["ara", "eng"]) copy(path.join(dir("@tesseract.js-data/" + l), "4.0.0_best_int", l + ".traineddata.gz"));
for (const f of fs.readdirSync(out)) console.log(String(fs.statSync(path.join(out, f)).size).padStart(9), f);
