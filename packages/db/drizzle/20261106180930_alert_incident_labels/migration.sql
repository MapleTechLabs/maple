-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "labels_json" jsonb;
