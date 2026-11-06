// In-memory Firestore: the subset of the REST API the Worker uses (get, list, equality query, atomic commit with
// preconditions and increments). Used by pfm-worker.test.mjs and by the browser test harness.
// toFsValue / fsToJs are passed in: the tests take them from worker-3.js itself.
export const ROOT = "projects/p/databases/(default)/documents";
export function makeFs(toFsValue, fsToJs) {

  const docs = new Map();   // name -> { data (JS), updateTime }
  let clock = 0, commits = 0;
  const tick = () => new Date(Date.UTC(2026, 0, 1) + ++clock).toISOString().replace("Z", "000Z");
  const err = (status) => { throw new Error("firestore: " + JSON.stringify({ error: { status } })); };
  const toDoc = (name, e) => ({ name, fields: Object.fromEntries(Object.entries(e.data).map(([k, v]) => [k, toFsValue(v)])), updateTime: e.updateTime });
  const setPath = (obj, path, fn) => { const seg = path.split("."); let o = obj; for (const s of seg.slice(0, -1)) o = o[s] = o[s] && typeof o[s] === "object" ? o[s] : {}; const k = seg.at(-1); o[k] = fn(o[k]); };
  return {
    docs, get commits() { return commits; },
    async fsGet(_t, rel) { const n = ROOT + "/" + rel, e = docs.get(n); return e ? toDoc(n, e) : null; },
    async fsList(_t, rel) { const pre = ROOT + "/" + rel + "/"; return [...docs].filter(([n]) => n.startsWith(pre) && !n.slice(pre.length).includes("/")).map(([n, e]) => toDoc(n, e)); },
    async fsQuerySub(_t, parentRel, coll, filters, limit) {
      const pre = ROOT + "/" + parentRel + "/" + coll + "/";
      return [...docs].filter(([n, e]) => n.startsWith(pre) && !n.slice(pre.length).includes("/") && filters.every(([k, op, v]) => op === "EQUAL" ? e.data[k] === v : v.includes(e.data[k])))
        .slice(0, limit).map(([n, e]) => toDoc(n, e));
    },
    async fsCommit(_t, writes) {
      // all preconditions first (atomic), then apply
      for (const w of writes) {
        const name = w.update?.name || w.delete || w.transform?.document, cd = w.currentDocument, e = docs.get(name);
        if (!(name.startsWith(ROOT + "/") && name.slice(ROOT.length + 1).split("/").length % 2 === 0)) throw new Error("bad doc path " + name);
        if (cd?.exists === false && e) err("ALREADY_EXISTS");
        if (cd?.exists === true && !e) err("NOT_FOUND");
        if (cd?.updateTime && (!e || e.updateTime !== cd.updateTime)) err("FAILED_PRECONDITION");
      }
      const t = tick(); commits++;
      for (const w of writes) {
        if (w.delete) { docs.delete(w.delete); continue; }
        const name = w.update?.name || w.transform.document;
        const cur = docs.get(name)?.data || {};
        let data;
        if (w.update) {
          const f = Object.fromEntries(Object.entries(w.update.fields).map(([k, v]) => [k, fsToJs(v)]));
          data = w.updateMask ? { ...cur, ...Object.fromEntries(w.updateMask.fieldPaths.map((k) => [k, f[k]])) } : f;
        } else data = structuredClone(cur);
        for (const ft of w.transform?.fieldTransforms || w.updateTransforms || []) setPath(data, ft.fieldPath, (old) => (old || 0) + Number(ft.increment.integerValue));
        docs.set(name, { data, updateTime: t });
      }
      return {};
    },
  };
}

