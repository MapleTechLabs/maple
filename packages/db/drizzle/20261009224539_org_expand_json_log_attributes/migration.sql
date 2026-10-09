-- metadata
ALTER TABLE "org_ingest_sampling_policies" ADD COLUMN IF NOT EXISTS "expand_json_log_attributes" boolean NOT NULL DEFAULT false;
