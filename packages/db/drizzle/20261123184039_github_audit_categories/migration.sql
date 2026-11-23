-- metadata
ALTER TABLE "vcs_installations" ADD COLUMN IF NOT EXISTS "audit_categories" jsonb NOT NULL DEFAULT '{}';
