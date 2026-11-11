-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'public';
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "password_hash" text;
