-- metadata
ALTER TABLE "oauth_auth_states" ADD COLUMN IF NOT EXISTS "github_installation_ids" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "vcs_installations" ADD COLUMN IF NOT EXISTS "repository_discovery" jsonb;
