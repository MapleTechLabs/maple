-- MCP OAuth and CLI device lookups now use a keyed HMAC instead of a bare SHA-256, so rows
-- written before this release can never match again. Drop them rather than let them expire:
-- MCP clients sign in once more and an in-flight CLI login restarts. Their access keys are
-- revoked first, since the refresh rows are what lists them for revocation: those clients are
-- signed out immediately rather than within the hour.
UPDATE "api_keys" SET "revoked" = true, "revoked_at" = now()
WHERE "revoked" = false AND "id" IN (SELECT "access_key_id" FROM "mcp_oauth_refresh_tokens");--> statement-breakpoint
DELETE FROM "mcp_oauth_refresh_tokens";--> statement-breakpoint
DELETE FROM "mcp_oauth_authorizations";--> statement-breakpoint
DELETE FROM "cli_device_authorizations";
