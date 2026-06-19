// ---------------------------------------------------------------------------
// Data migration 0025 — re-key BYO-ClickHouse ingest readiness off the
// Tinybird-coupled project-revision hash and onto the ClickHouse migration
// version (`clickHouseSchemaVersion`, currently "4").
//
// Background: `org_clickhouse_settings.schema_version` used to hold
// `clickHouseProjectRevision` — the GLOBAL revision shared with the Tinybird
// manifest. The ingest gateway now gates readiness on the migration version
// instead (emitted as `SCHEMA_VERSION` into the Rust gateway). To avoid
// regressing orgs that were *already ready* under the old scheme across the
// cutover, translate rows stamped with the old project revision to the new
// migration version.
//
// Scope is deliberately narrow: only the exact project-revision value that meant
// "ready" at cutover is translated. We do NOT touch older/stale revision strings
// — for those we can't prove the live ClickHouse is at migration 4 from D1
// alone, so they are left for the verified `schemaDiff` self-heal (which checks
// the live schema before stamping) or a re-apply.
//
// Both literals are pinned point-in-time: a future migration (0005+) bumps
// `clickHouseSchemaVersion`, but this backfill must keep translating the
// cutover-era revision to "4" exactly, so it does not import the live constant.
//
// Idempotent: guarded by `_maple_data_migrations`, and the UPDATE is a no-op when
// no row carries the old revision (the common case — most orgs self-heal).
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm"
import type { MapleLibsqlClient } from "../client"

const MIGRATION_ID = "0025-clickhouse-schema-version-rekey"

// The `clickHouseProjectRevision` value that meant "ready" immediately before the
// migration-version cutover (CH migrations 1–4). Pinned literal — see header.
const CUTOVER_PROJECT_REVISION = "019c3db4cf690e3748b302098cae4c9213d18c55355db9fc68ea44982c7a980a"
// `clickHouseSchemaVersion` at cutover (latest migration version). Pinned literal.
const CUTOVER_SCHEMA_VERSION = "4"

export async function migrateClickHouseSchemaVersionRekey(db: MapleLibsqlClient): Promise<void> {
	await db.run(
		sql`CREATE TABLE IF NOT EXISTS _maple_data_migrations (id text PRIMARY KEY, applied_at integer NOT NULL)`,
	)

	const applied = await db.all<{ id: string }>(
		sql`SELECT id FROM _maple_data_migrations WHERE id = ${MIGRATION_ID}`,
	)
	if (applied.length > 0) return

	// `org_clickhouse_settings` is created by an earlier schema migration; guard so
	// this is safe on a DB that hasn't reached that migration yet (e.g. a unit test
	// seeding only what it needs).
	const tables = await db.all<{ name: string }>(
		sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'org_clickhouse_settings'`,
	)
	if (tables.length > 0) {
		await db.run(
			sql`UPDATE org_clickhouse_settings SET schema_version = ${CUTOVER_SCHEMA_VERSION} WHERE schema_version = ${CUTOVER_PROJECT_REVISION}`,
		)
	}

	await db.run(
		sql`INSERT INTO _maple_data_migrations (id, applied_at) VALUES (${MIGRATION_ID}, ${Date.now()})`,
	)
}
