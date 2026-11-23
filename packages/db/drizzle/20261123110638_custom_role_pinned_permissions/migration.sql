-- metadata
ALTER TABLE "cli_device_authorizations" ADD COLUMN IF NOT EXISTS "approved_permissions" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "device_credentials" ADD COLUMN IF NOT EXISTS "permissions" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "mcp_oauth_authorizations" ADD COLUMN IF NOT EXISTS "approved_permissions" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "mcp_oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "permissions" jsonb;
