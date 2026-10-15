-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "peak_severity" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rule_states" ADD COLUMN IF NOT EXISTS "history_json" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "thresholds_json" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "breaches_out_of" integer;
--> statement-breakpoint
-- Backfill: every existing rule becomes one tier from its legacy columns. The
-- reader falls back to the same derivation for a NULL, so this is idempotent.
UPDATE "alert_rules" SET "thresholds_json" = jsonb_build_array(jsonb_build_object(
	'severity', "severity",
	'value', "threshold",
	'upper', "threshold_upper",
	'recoveryValue', NULL,
	'destinationIds', "destination_ids_json"
)) WHERE "thresholds_json" IS NULL;
