-- metadata
ALTER TABLE "alert_maintenance_windows" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;
