-- metadata
CREATE TABLE IF NOT EXISTS "org_ingest_custom_keys" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"allowed_signals" jsonb,
	"rate_limit_rps" integer,
	"resource_attributes" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"expires_at" timestamp with time zone,
	"rolled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "org_ingest_custom_keys_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "org_ingest_custom_keys_key_hash_unique" ON "org_ingest_custom_keys" USING btree ("key_hash");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "org_ingest_custom_keys_org_id_idx" ON "org_ingest_custom_keys" USING btree ("org_id");
