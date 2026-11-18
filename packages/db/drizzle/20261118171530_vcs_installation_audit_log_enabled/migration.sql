-- metadata
ALTER TABLE "vcs_installations" ADD COLUMN IF NOT EXISTS "audit_log_enabled" boolean NOT NULL DEFAULT true;
