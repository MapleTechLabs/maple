-- metadata
CREATE TABLE IF NOT EXISTS "org_ingest_rule_settings" (
	"org_id" text NOT NULL,
	"hash_salt" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "org_ingest_rule_settings_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "org_ingest_rules" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"position" integer NOT NULL DEFAULT 0,
	"spec_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "org_ingest_rules_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "org_ingest_rules_org_idx" ON "org_ingest_rules" USING btree ("org_id");
