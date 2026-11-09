-- metadata
CREATE TABLE IF NOT EXISTS "external_data_source_catalog_entries" (
	"source_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"row_estimate" double precision,
	"source_note" text,
	"detected_time_field" text,
	"fields" jsonb NOT NULL,
	"exposed" boolean NOT NULL DEFAULT true,
	"note" text,
	"time_field_override" text,
	"field_notes" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_data_source_catalog_entries_pk" PRIMARY KEY ("source_id", "name")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "external_data_sources" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"environment" text NOT NULL,
	"tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"agent_access" boolean NOT NULL DEFAULT true,
	"agent_pii" boolean NOT NULL DEFAULT false,
	"config" jsonb NOT NULL,
	"secret_ciphertext" text,
	"secret_iv" text,
	"secret_tag" text,
	"secret_hint" text,
	"status" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"catalog_refreshed_at" timestamp with time zone,
	"catalog_error" text,
	"examples" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "external_data_sources_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "external_data_source_catalog_entries_org_idx" ON "external_data_source_catalog_entries" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "external_data_sources_org_name_unique" ON "external_data_sources" USING btree ("org_id", "name");
--> statement-breakpoint
-- metadata
ALTER TABLE "external_data_source_catalog_entries" ADD CONSTRAINT "external_data_source_catalog_entries_x60VonL2VphD_fk" FOREIGN KEY ("source_id") REFERENCES "external_data_sources" ("id") ON DELETE CASCADE;
