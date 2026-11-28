-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "security_enabled" boolean NOT NULL DEFAULT false;
