/**
 * Migration 0041: alert_checks level, the highest severity tier a check breached ('' when none).
 * `requiredForIngest: false`: the gateway never writes alert_checks.
 */
export const migration_0041_alert_checks_level = {
	version: 41,
	description: "Add Level to alert_checks so checks say which severity tier breached",
	requiredForIngest: false,
	statements: ["ALTER TABLE alert_checks ADD COLUMN IF NOT EXISTS Level LowCardinality(String) DEFAULT ''"],
} as const
