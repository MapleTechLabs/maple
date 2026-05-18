// ---------------------------------------------------------------------------
// Data migration 0014 — add the optional free-text `notes` column to
// `alert_rules` so operators can annotate why a rule exists / runbook links.
//
// Idempotent: guarded by the `_maple_data_migrations` bookkeeping table and an
// `alert_rules` shape probe, so it is safe on every libSQL startup / D1 boot
// and a no-op once the column already exists (e.g. after `db:push`).
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm"
import type { MapleLibsqlClient } from "../client"

const MIGRATION_ID = "0014-alert-rule-notes"

export async function migrateAlertRuleNotes(db: MapleLibsqlClient): Promise<void> {
	await db.run(
		sql`CREATE TABLE IF NOT EXISTS _maple_data_migrations (id text PRIMARY KEY, applied_at integer NOT NULL)`,
	)

	const applied = await db.all<{ id: string }>(
		sql`SELECT id FROM _maple_data_migrations WHERE id = ${MIGRATION_ID}`,
	)
	if (applied.length > 0) return

	const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(alert_rules)`)
	const hasNotes = columns.some((column) => column.name === "notes")
	if (!hasNotes) {
		await db.run(sql`ALTER TABLE alert_rules ADD COLUMN notes text`)
	}

	await db.run(
		sql`INSERT INTO _maple_data_migrations (id, applied_at) VALUES (${MIGRATION_ID}, ${Date.now()})`,
	)
}
