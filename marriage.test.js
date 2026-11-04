// C203 (v120): marriageRule + marriageFacts من worker-3.js على مخزن صلاتٍ في الذاكرة (بلا Firestore).
// الاستعمال: node marriage.test.js
const src = require("fs").readFileSync(__dirname + "/worker-3.js", "utf8");
const a = src.indexOf("const MARRIAGE_MAX_WIVES"), b = src.indexOf("async function opRelationAdd");
const { marriageRule, marriageFacts } = new Function(src.slice(a, b) + "; return { marriageRule, marriageFacts };")();
// شجرة: gf ⇐ dad, aunt, unc · dad ⇐ me, bro · bro ⇐ niece · unc ⇐ cous, cous2 ⇐ cousd · me ⟷ wife (قائم)
const G = { gf: "male", dad: "male", aunt: "female", unc: "male", me: "male", bro: "male", niece: "female", cous: "female", cous2: "male", cousd: "female", wife: "female", w2: "female", w3: "female", w4: "female", w5: "female", h2: "male" };
const P = (f, t) => ({ type: "parent", from: f, to: t });
const rels = [P("gf", "dad"), P("gf", "aunt"), P("gf", "unc"), P("dad", "me"), P("dad", "bro"), P("bro", "niece"), P("unc", "cous"), P("unc", "cous2"), P("cous2", "cousd"), { type: "spouse", from: "me", to: "wife" }];
const q = async (filters, lim, fallback) => fallback(rels);
const parentsOf = async (ids) => rels.filter((r) => r.type === "parent" && ids.indexOf(r.to) >= 0);
const why = async (type, f, t, extra) => { if (extra) rels.push(...extra); const r = marriageRule(await marriageFacts(type, f, t, G[f], G[t], q, parentsOf)); if (extra) rels.splice(rels.length - extra.length); return r; };
(async () => {
  const cases = [
    ["cousin ok", "spouse", "me", "cous", null],
    ["cousin's daughter ok", "spouse", "me", "cousd", null],
    ["aunt", "spouse", "me", "aunt", /direct kin/],
    ["niece", "spouse", "me", "niece", /direct kin/],
    ["grandfather/same gender", "spouse", "me", "gf", /same gender/],
    ["second husband", "spouse", "h2", "wife", /current husband/],
    ["second husband as former ok", "ex_spouse", "h2", "wife", null],
    ["second wife ok", "spouse", "me", "w2", null],
  ];
  let ok = 0;
  for (const [name, type, f, t, want] of cases) {
    const got = await why(type, f, t);
    const pass = want ? want.test(got || "") : got === null;
    if (pass) ok++; else console.error("✗", name, got);
  }
  const four = ["wife", "w2", "w3", "w4"].map((w) => ({ type: "spouse", from: "me", to: w }));
  const fifth = await why("spouse", "me", "w5", four.slice(1));
  if (/four current wives/.test(fifth || "")) ok++; else console.error("✗ fifth wife", fifth);
  const total = cases.length + 1;
  console.log((ok === total ? "✓" : "✗") + " worker marriage rules: " + ok + "/" + total);
  process.exitCode = ok === total ? 0 : 1;
})();
