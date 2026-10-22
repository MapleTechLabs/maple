-- metadata
ALTER TABLE "alert_rule_claims" ADD COLUMN IF NOT EXISTS "consecutive_limit_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rule_states" ADD COLUMN IF NOT EXISTS "last_error_kind" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "slowed_interval_minutes" integer;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "slowed_at" timestamp with time zone;
