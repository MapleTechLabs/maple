-- metadata
ALTER TABLE "vcs_repositories" ADD COLUMN IF NOT EXISTS "rule_suites_read_until" timestamp with time zone;
