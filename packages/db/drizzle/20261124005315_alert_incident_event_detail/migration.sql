-- metadata
ALTER TABLE "alert_incident_events" ADD COLUMN IF NOT EXISTS "detail" text;
