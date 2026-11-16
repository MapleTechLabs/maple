-- metadata
DROP INDEX IF EXISTS "security_audit_runs_one_running_idx";
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_runs" ADD COLUMN IF NOT EXISTS "pr_number" integer;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_targets" ADD COLUMN IF NOT EXISTS "pr_check_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_targets" ADD COLUMN IF NOT EXISTS "pr_check_block_at" text DEFAULT 'high';
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "security_audit_runs_one_running_idx" ON "security_audit_runs" USING btree ("target_id") WHERE finished_at is null and pr_number is null;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "security_audit_runs_one_running_pr_idx" ON "security_audit_runs" USING btree ("target_id", "pr_number") WHERE finished_at is null and pr_number is not null;
