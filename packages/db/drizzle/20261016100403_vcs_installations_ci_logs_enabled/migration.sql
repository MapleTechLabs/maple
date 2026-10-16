-- metadata
ALTER TABLE "vcs_installations" ADD COLUMN IF NOT EXISTS "ci_logs_enabled" boolean NOT NULL DEFAULT false;
