-- metadata
ALTER TABLE "org_ingest_rule_stats" ADD COLUMN IF NOT EXISTS "parse_failed" bigint NOT NULL DEFAULT 0;
