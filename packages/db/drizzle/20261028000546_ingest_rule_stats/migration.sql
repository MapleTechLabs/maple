-- metadata
CREATE TABLE IF NOT EXISTS "org_ingest_rule_stats" (
	"org_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"signal" text NOT NULL,
	"matched" bigint NOT NULL DEFAULT 0,
	"dropped" bigint NOT NULL DEFAULT 0,
	"dropped_bytes" bigint NOT NULL DEFAULT 0,
	"redacted_values" bigint NOT NULL DEFAULT 0,
	CONSTRAINT "org_ingest_rule_stats_pkey" PRIMARY KEY ("org_id", "rule_id", "bucket", "signal")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "org_ingest_rule_stats_org_bucket_idx" ON "org_ingest_rule_stats" USING btree ("org_id", "bucket");
