/**
 * Migration 0036: alert_checks skip reason.
 *
 * A skipped check now records why: `no_data`, `below_min_samples` or `no_value`,
 * '' on every other row. `requiredForIngest: false`: the gateway never writes
 * alert_checks; the scheduler ingests it through Tinybird.
 */
export const migration_0036_alert_checks_skip_reason = {
	version: 36,
	description: "Add SkipReason to alert_checks so skipped checks say why",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE alert_checks ADD COLUMN IF NOT EXISTS SkipReason LowCardinality(String) DEFAULT ''",
	],
} as const
