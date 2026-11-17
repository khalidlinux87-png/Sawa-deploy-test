// Schema migrations for the Projects data model (pfm/PROJECTS.md, section 2).
// Firestore has no migration tool in this repo, so the Worker runs these itself. Each user's applied version lives in
// `pfm/{uid}/meta/projects` as { schemaVersion, appliedAt }. Pure: the caller passes a small storage adapter.
//
// Adapter contract (the Worker implements it on top of fsGet and the atomic commit):
//   get(path)        -> data object | null
//   set(path, data)  -> writes the document; the Worker uses a precondition so two runs cannot both apply a step
//
// Rules for every migration:
//   - additive and idempotent: running it twice must not change the result
//   - never rewrites money or quantities; a new field gets a default at read time instead
//   - `down` is documentation only. Rolling back means shipping a new forward migration.

import { PfmError, paths } from "./projects-core.mjs";

export const PROJECTS_SCHEMA_VERSION = 2;

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "projects_init",
    // The Projects collections are new, so there is nothing to backfill. This step only records the baseline,
    // so that later migrations know which shape a user's documents have.
    async up() {},
    async down() {},
  },
  {
    version: 2,
    name: "dated_prices_and_files",
    // C287: BOQ lines gain priceDate, supplier, pricedAt and priceLog; projects gain files/{fid} and files/{fid}/parts.
    // Nothing is rewritten: a line without priceDate/pricedAt reads as priced when its revision was created
    // (priceDateOfRow / pricedAtOfRow in pfm-worker.mjs), and a missing priceLog reads as that single price.
    async up() {},
    async down() {},
  },
]);

// Throws if versions are not 1, 2, 3, … with no gaps or repeats. Runs at import time so a bad edit fails loudly.
export function assertMigrationOrder(list = MIGRATIONS) {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new PfmError("migration_order", `expected version ${i + 1}, got ${m.version} (${m.name})`);
    if (typeof m.up !== "function") throw new PfmError("migration_order", `${m.name} has no up()`);
  });
  return true;
}
assertMigrationOrder();

/**
 * Brings one user's Projects data to `target` (default: the code's version).
 * Returns { version, applied: [names] }. Safe to call on every request; it does nothing when up to date.
 * A failing `up` throws before the version is recorded, so the next run retries that step.
 */
export async function migrateProjects(db, uid, { target = PROJECTS_SCHEMA_VERSION, now = () => new Date().toISOString(), migrations = MIGRATIONS } = {}) {
  if (!uid) throw new PfmError("bad_uid", "uid required");
  const metaPath = paths.meta(uid);
  const meta = await db.get(metaPath);
  let current = Number.isInteger(meta?.schemaVersion) ? meta.schemaVersion : 0;

  // A user whose data was written by a newer build must not be read by an older one.
  if (current > target) throw new PfmError("schema_ahead", `stored ${current}, code supports ${target}`);

  const applied = [];
  for (const m of migrations) {
    if (m.version <= current || m.version > target) continue;
    await m.up(db, uid);
    await db.set(metaPath, { schemaVersion: m.version, appliedAt: now(), lastMigration: m.name });
    current = m.version;
    applied.push(m.name);
  }
  return { version: current, applied };
}
