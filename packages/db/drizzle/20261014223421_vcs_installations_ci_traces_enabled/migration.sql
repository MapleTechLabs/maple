-- metadata
ALTER TABLE "vcs_installations" ADD COLUMN IF NOT EXISTS "ci_traces_enabled" boolean NOT NULL DEFAULT true;
