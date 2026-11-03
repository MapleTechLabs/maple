-- metadata
CREATE TABLE IF NOT EXISTS "sources" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"platform" text NOT NULL,
	"is_default" boolean NOT NULL DEFAULT false,
	"key_hash" text,
	"key_prefix" text,
	"allowed_signals" jsonb,
	"rate_limit_rps" integer,
	"resource_attributes" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"expires_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"rolled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "sources_key_hash_unique" ON "sources" USING btree ("key_hash");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "sources_org_default_unique" ON "sources" USING btree ("org_id") WHERE "is_default" = TRUE;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "sources_org_id_idx" ON "sources" USING btree ("org_id");
--> statement-breakpoint
-- Every org with ingest keys gets its default source, standing for the public/private pair.
INSERT INTO "sources" ("id", "org_id", "name", "platform", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "org_id", 'Default', 'opentelemetry', true, now(), now()
FROM "org_ingest_keys"
ON CONFLICT DO NOTHING;
