-- metadata
ALTER TABLE "error_issue_fingerprints" ADD COLUMN IF NOT EXISTS "origin_issue_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "error_issues" ADD COLUMN IF NOT EXISTS "merged_into_issue_id" text;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "error_issues_org_merged_into_idx" ON "error_issues" USING btree ("org_id", "merged_into_issue_id") WHERE "merged_into_issue_id" is not null;
