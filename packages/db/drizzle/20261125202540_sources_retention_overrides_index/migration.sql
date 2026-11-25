-- metadata
CREATE INDEX IF NOT EXISTS "sources_retention_overrides_idx" ON "sources" USING btree ("org_id") WHERE "retention_days" != '{}';
