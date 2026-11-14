-- metadata
CREATE INDEX IF NOT EXISTS "error_issues_org_kind_created_idx" ON "error_issues" USING btree ("org_id", "kind", "created_at");
