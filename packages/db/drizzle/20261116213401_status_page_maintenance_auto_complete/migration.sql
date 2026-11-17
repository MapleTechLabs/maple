-- metadata
ALTER TABLE "status_page_incidents" ADD COLUMN IF NOT EXISTS "auto_complete" boolean NOT NULL DEFAULT true;
