-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "security_audit_runs_one_running_idx" ON "security_audit_runs" USING btree ("target_id") WHERE "status" = 'in_progress';
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "security_audit_targets_org_repo_branch_idx" ON "security_audit_targets" USING btree ("org_id", "repository", "branch");
