-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "privacy_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "terms_url" text;
