-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "evaluation_interval_minutes" integer;
