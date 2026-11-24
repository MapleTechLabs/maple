-- metadata
CREATE TABLE IF NOT EXISTS "source_map_files" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"debug_id" text,
	"service_name" text,
	"version" text,
	"minified_path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"has_sources_content" boolean NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"last_used_at" timestamp with time zone,
	CONSTRAINT "source_map_files_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "source_map_files_org_created_idx" ON "source_map_files" USING btree ("org_id", "created_at");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "source_map_files_org_debug_id_idx" ON "source_map_files" USING btree ("org_id", "debug_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "source_map_files_org_release_path_idx" ON "source_map_files" USING btree ("org_id", "service_name", "version", "minified_path") WHERE "debug_id" IS NULL;
