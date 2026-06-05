// ---------------------------------------------------------------------------
// Schema repair 0018 — ensure adaptive-alert rule columns exist.
//
// Drizzle migration 0018 adds the anomaly incident tables plus alert incident
// metadata and these alert_rules columns. Some libSQL/Drizzle local runs can
// record 0018 as applied after creating the new tables and incident columns
// while missing the final alert_rules ALTER statements. This idempotent guard
// keeps fresh test/local databases and previously partial databases aligned.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm"
import type { MapleLibsqlClient } from "../client"

const MIGRATION_ID = "0018-alert-anomaly-rule-columns"

export async function ensureAlertAnomalyRuleColumns(db: MapleLibsqlClient): Promise<void> {
	await db.run(
		sql`CREATE TABLE IF NOT EXISTS _maple_data_migrations (id text PRIMARY KEY, applied_at integer NOT NULL)`,
	)

	const applied = await db.all<{ id: string }>(
		sql`SELECT id FROM _maple_data_migrations WHERE id = ${MIGRATION_ID}`,
	)
	if (applied.length > 0) return

	const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(alert_rules)`)
	const columnNames = new Set(columns.map((column) => column.name))

	if (!columnNames.has("threshold_mode")) {
		await db.run(sql`ALTER TABLE alert_rules ADD threshold_mode text DEFAULT 'static' NOT NULL`)
	}
	if (!columnNames.has("anomaly_config_json")) {
		await db.run(sql`ALTER TABLE alert_rules ADD anomaly_config_json text`)
	}
	if (!columnNames.has("evaluation_interval_minutes")) {
		await db.run(
			sql`ALTER TABLE alert_rules ADD evaluation_interval_minutes integer DEFAULT 1 NOT NULL`,
		)
	}

	await db.run(
		sql`INSERT INTO _maple_data_migrations (id, applied_at) VALUES (${MIGRATION_ID}, ${Date.now()})`,
	)
}
