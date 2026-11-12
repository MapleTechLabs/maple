-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "audit_filters_json" jsonb;
