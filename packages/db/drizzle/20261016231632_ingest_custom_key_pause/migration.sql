-- destructive
ALTER TABLE "org_ingest_custom_keys" DROP COLUMN IF EXISTS "enabled";
--> statement-breakpoint
-- metadata
ALTER TABLE "org_ingest_custom_keys" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "org_ingest_custom_keys" ADD COLUMN IF NOT EXISTS "paused_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "org_ingest_custom_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
