// Usage: node pfm/projects-migrations.test.mjs
import assert from "node:assert/strict";
import { migrateProjects, assertMigrationOrder, PROJECTS_SCHEMA_VERSION, MIGRATIONS } from "./projects-migrations.mjs";
import { paths } from "./projects-core.mjs";

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; } };

// In-memory adapter: the same two calls the Worker's Firestore wrapper provides.
const memDb = (seed = {}) => {
  const docs = new Map(Object.entries(seed));
  const writes = [];
  return {
    docs, writes,
    async get(p) { return docs.has(p) ? structuredClone(docs.get(p)) : null; },
    async set(p, data) { writes.push(p); docs.set(p, structuredClone(data)); },
  };
};
const clock = () => "2026-11-09T00:00:00.000Z";

await t("fresh user: runs every migration and records the version", async () => {
  const db = memDb();
  const r = await migrateProjects(db, "u1", { now: clock });
  assert.equal(r.version, PROJECTS_SCHEMA_VERSION);
  assert.deepEqual(r.applied, MIGRATIONS.map((m) => m.name));
  assert.equal(db.docs.get(paths.meta("u1")).schemaVersion, PROJECTS_SCHEMA_VERSION);
  assert.equal(db.docs.get(paths.meta("u1")).appliedAt, "2026-11-09T00:00:00.000Z");
});

await t("up to date: a second run applies nothing and writes nothing", async () => {
  const db = memDb();
  await migrateProjects(db, "u1", { now: clock });
  const before = db.writes.length;
  const r = await migrateProjects(db, "u1", { now: clock });
  assert.deepEqual(r.applied, []);
  assert.equal(db.writes.length, before);
});

await t("schema_ahead: refuses data written by a newer build", async () => {
  const db = memDb({ [paths.meta("u2")]: { schemaVersion: PROJECTS_SCHEMA_VERSION + 4 } });
  await assert.rejects(migrateProjects(db, "u2"), { code: "schema_ahead" });
});

await t("a failing step is not recorded, so the next run retries it", async () => {
  let fail = true;
  const steps = [
    { version: 1, name: "one", async up() {}, async down() {} },
    { version: 2, name: "two", async up() { if (fail) throw new Error("disk full"); }, async down() {} },
  ];
  const db = memDb();
  await assert.rejects(migrateProjects(db, "u3", { now: clock, migrations: steps, target: 2 }), /disk full/);
  assert.equal(db.docs.get(paths.meta("u3")).schemaVersion, 1);   // step 1 kept, step 2 not recorded
  fail = false;
  const r = await migrateProjects(db, "u3", { now: clock, migrations: steps, target: 2 });
  assert.deepEqual(r.applied, ["two"]);
  assert.equal(r.version, 2);
});

await t("target below the code version stops at that version", async () => {
  const db = memDb();
  const r = await migrateProjects(db, "u4", { target: 0, now: clock });
  assert.equal(r.version, 0);
  assert.deepEqual(r.applied, []);
});

await t("assertMigrationOrder: versions must run 1, 2, 3 with no gaps", () => {
  assert.equal(assertMigrationOrder(MIGRATIONS), true);
  assert.throws(() => assertMigrationOrder([{ version: 2, name: "x", up() {} }]), { code: "migration_order" });
  assert.throws(() => assertMigrationOrder([{ version: 1, name: "x", up() {} }, { version: 1, name: "y", up() {} }]), { code: "migration_order" });
  assert.throws(() => assertMigrationOrder([{ version: 1, name: "x" }]), { code: "migration_order" });
});

await t("bad uid is refused before any read", async () => {
  await assert.rejects(migrateProjects(memDb(), ""), { code: "bad_uid" });
});

console.log(process.exitCode ? "FAILED" : `projects-migrations: ${n} passed`);
