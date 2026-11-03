-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "draft" boolean NOT NULL DEFAULT false;
