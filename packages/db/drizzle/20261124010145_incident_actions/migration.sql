-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "first_acknowledged_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "quiet_since" timestamp with time zone;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_incidents_quiet_idx" ON "alert_incidents" USING btree ("org_id", "rule_id") WHERE "quiet_since" IS NOT NULL;
