-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "logo_dark_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "favicon_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "support_url" text;
