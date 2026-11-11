-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "logo_dark_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "favicon_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "support_url" text;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incidents_open_maintenance_idx" ON "status_page_incidents" USING btree ("scheduled_start") WHERE "kind" = 'maintenance' and "resolved_at" is null;
