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
