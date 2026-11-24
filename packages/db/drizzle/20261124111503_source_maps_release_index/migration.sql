-- metadata
DROP INDEX IF EXISTS "source_map_files_org_release_path_idx";
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "source_map_files_org_release_path_idx" ON "source_map_files" USING btree ("org_id", "service_name", "version", "minified_path") WHERE "debug_id" IS NULL;
