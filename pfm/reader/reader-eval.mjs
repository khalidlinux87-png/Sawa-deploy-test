// Measures the reader on labelled samples (IMPORT-DESIGN.md §4.6). Samples live in the PRIVATE samples repository:
//   <dir>/<issuer>/<name>.jpg  +  <name>.json  {truth:{transaction_id, timestamp, amount, from_account, to_account, to_name, note}}
//   <dir>/context.json         {myAccounts:[…], myName}
// Usage: NODE_PATH=<scratch>/node_modules node pfm/reader/reader-eval.mjs <dir>
// For every field: right, flagged (null or in verify — the user checks it), or WRONG (a wrong value not flagged).
// Exit check (§9): zero WRONG amounts.
import fs from "node:fs"; import path from "node:path";
import { readImage } from "./extract.mjs";
import { normAr } from "./text.mjs";
import bankak from "./templates/bankak.mjs";
import { decode, makeOcr } from "./dev/ocr-node.mjs";

const dir = process.argv[2]; if (!dir) { console.error("usage: reader-eval.mjs <samples dir>"); process.exit(2); }
const ctx = JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8"));
const ocr = await makeOcr();
const FIELDS = ["transaction_id", "timestamp", "amount", "from_account", "to_account", "to_name", "note", "bill_id"];
const pick = (r, f) => ({ transaction_id: r.transaction_id, timestamp: r.timestamp, amount: r.amount.value, from_account: r.sender.account_identifier,
  to_account: r.recipient.account_identifier, to_name: r.recipient.name, note: r.note, bill_id: r.bill_id ?? null })[f];
const flagOf = { transaction_id: "transaction_id", timestamp: "timestamp", amount: "amount", from_account: "sender", to_account: "recipient", to_name: "recipient", note: null, bill_id: null };
const same = (f, a, b) => (f === "to_name" || f === "note" ? normAr(a) === normAr(b) : a === b);
const skip = (f, truth) => f === "note" && truth.bill_id;   // a bill note is made from its bill id, scored as bill_id
const tally = Object.fromEntries(FIELDS.map((f) => [f, { right: 0, flagged: 0, WRONG: 0, absent: 0 }]));
let n = 0, ms = 0;
for (const issuer of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()))
  for (const f of fs.readdirSync(path.join(dir, issuer)).filter((x) => /\.(jpe?g)$/i.test(x)).sort()) {
    const truth = JSON.parse(fs.readFileSync(path.join(dir, issuer, f.replace(/\.\w+$/, ".json")), "utf8")).truth;
    const t0 = Date.now(); const r = await readImage(decode(path.join(dir, issuer, f)), ocr, [bankak], ctx); ms += Date.now() - t0; n++;
    const line = [];
    for (const fld of FIELDS) {
      if (skip(fld, truth)) continue;
      const want = truth[fld] ?? null, got = r ? pick(r, fld) : null;
      const flagged = !r || got == null || (flagOf[fld] && r.verify.some((v) => v.field === flagOf[fld]));
      let k;
      if (want == null && got == null) k = "absent";
      else if (got != null && want != null && same(fld, got, want)) k = "right";
      else if (flagged) k = "flagged";
      else k = "WRONG";
      tally[fld][k]++;
      if (k !== "right" && k !== "absent") line.push(`${fld}:${k} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    }
    console.log(`${issuer}/${f} ${r ? r.status : "NO MATCH"} kind=${r && r.kind} svc=${r && r.service_type} cat=${r && r.category_id}${line.length ? "\n   " + line.join("\n   ") : ""}`);
    if (r && r.verify.length) console.log("   verify:", r.verify.map((v) => `${v.field} (${v.reason})`).join("; "));
  }
await ocr.close();
console.log(`\n${n} samples, ${Math.round(ms / Math.max(n, 1))} ms each`);
console.table(tally);
if (tally.amount.WRONG) { console.error("FAIL: wrong amount not flagged"); process.exitCode = 1; }
