-- metadata
ALTER TABLE "org_ingest_custom_keys" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "org_ingest_custom_keys" ADD COLUMN IF NOT EXISTS "paused_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "org_ingest_custom_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
--> statement-breakpoint
-- data: a disabled key stays off as a key paused until resumed.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'org_ingest_custom_keys' AND column_name = 'enabled') THEN
		UPDATE "org_ingest_custom_keys" SET "paused_at" = now() WHERE "enabled" = false AND "paused_at" IS NULL;
	END IF;
END $$;
--> statement-breakpoint
-- destructive
ALTER TABLE "org_ingest_custom_keys" DROP COLUMN IF EXISTS "enabled";
