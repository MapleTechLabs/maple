-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "log_drain_source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "log_drain_error" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "log_drains_json" jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "log_drains_checked_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "supabase_projects_log_drain_source_idx" ON "supabase_projects" USING btree ("log_drain_source_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD CONSTRAINT "supabase_projects_log_drain_source_id_sources_id_fk" FOREIGN KEY ("log_drain_source_id") REFERENCES "sources" ("id") ON DELETE SET NULL;
