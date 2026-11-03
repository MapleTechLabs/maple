-- metadata
ALTER TABLE "gcp_resources" ADD COLUMN IF NOT EXISTS "details" jsonb;
