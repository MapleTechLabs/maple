-- metadata
ALTER TABLE "onboarding_agent_runs" ADD COLUMN IF NOT EXISTS "handoff_code_hash" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "onboarding_agent_runs" ADD COLUMN IF NOT EXISTS "api_key_id" text;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_agent_runs_handoff_code_hash_unq" ON "onboarding_agent_runs" USING btree ("handoff_code_hash");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "onboarding_agent_runs_org_api_key_idx" ON "onboarding_agent_runs" USING btree ("org_id", "api_key_id");
