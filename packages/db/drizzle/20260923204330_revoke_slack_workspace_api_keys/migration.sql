-- Revoke the Maple API keys the Slack install once minted for the retired
-- standalone Slack agent, and drop their encrypted secrets. Nothing reads them
-- since the agent was removed, and installs no longer mint them. `api_key_id`
-- stays until a follow-up migration drops the `api_key_*` columns.
--
-- The keys were minted with `ApiKeysService.create`, never through MCP OAuth, so
-- no refresh family re-mints them: flipping `revoked` is the whole revoke.
-- Idempotent: already-revoked keys and already-cleared rows are skipped.
UPDATE "api_keys"
SET "revoked" = true, "revoked_at" = now()
WHERE "revoked" = false
	AND "id" IN (SELECT "api_key_id" FROM "slack_workspaces" WHERE "api_key_id" IS NOT NULL);
--> statement-breakpoint
UPDATE "slack_workspaces"
SET "api_key_secret_ciphertext" = NULL, "api_key_secret_iv" = NULL, "api_key_secret_tag" = NULL
WHERE "api_key_secret_ciphertext" IS NOT NULL
	OR "api_key_secret_iv" IS NOT NULL
	OR "api_key_secret_tag" IS NOT NULL;
