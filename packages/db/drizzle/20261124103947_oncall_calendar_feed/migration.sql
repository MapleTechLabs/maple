-- metadata
ALTER TABLE "oncall_schedules" ADD COLUMN IF NOT EXISTS "calendar_feed_token_hash" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "oncall_schedules" ADD COLUMN IF NOT EXISTS "calendar_feed_created_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "oncall_schedules_calendar_feed_idx" ON "oncall_schedules" USING btree ("calendar_feed_token_hash");
