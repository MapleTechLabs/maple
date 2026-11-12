-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "audit_count_from" timestamp with time zone;
