-- metadata
ALTER TABLE "anomaly_detector_settings" ADD COLUMN IF NOT EXISTS "included_environments_json" jsonb NOT NULL DEFAULT '[]';
