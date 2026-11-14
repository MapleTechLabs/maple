-- metadata
CREATE TABLE IF NOT EXISTS "error_issue_fingerprints" (
	"org_id" text NOT NULL,
	"fingerprint_hash" text NOT NULL,
	"issue_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "error_issue_fingerprints_org_id_fingerprint_hash_pk" PRIMARY KEY ("org_id", "fingerprint_hash")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "error_issue_fingerprints_issue_idx" ON "error_issue_fingerprints" USING btree ("org_id", "issue_id");
