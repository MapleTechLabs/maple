-- metadata
CREATE TABLE IF NOT EXISTS "error_grouping_keys" (
	"org_id" text NOT NULL,
	"fingerprint_hash" text NOT NULL,
	"grouping_key" text NOT NULL,
	"key_version" integer NOT NULL,
	"config_digest" text NOT NULL DEFAULT '',
	"rule" text NOT NULL,
	"pinned" boolean NOT NULL DEFAULT false,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "error_grouping_keys_org_id_fingerprint_hash_pk" PRIMARY KEY ("org_id", "fingerprint_hash")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "error_grouping_keys_key_idx" ON "error_grouping_keys" USING btree ("org_id", "grouping_key");
