-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "anomaly_incident_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "group_label" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "anomaly_signals_json" jsonb;
