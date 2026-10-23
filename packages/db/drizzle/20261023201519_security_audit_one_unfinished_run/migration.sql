-- metadata
DROP INDEX IF EXISTS "security_audit_runs_one_running_idx";
--> statement-breakpoint
-- Runs the engine marked done but that never settled: settle them, so the old one-in_progress index's
-- guarantee carries over and at most one unfinished run per target remains.
UPDATE "security_audit_runs" SET "status" = 'failed', "error" = 'abandoned: never settled', "finished_at" = now()
WHERE "finished_at" IS NULL AND "status" <> 'in_progress';
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "security_audit_runs_one_running_idx" ON "security_audit_runs" USING btree ("target_id") WHERE "finished_at" IS NULL;
