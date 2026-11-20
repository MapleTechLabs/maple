-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "activity_cursor" bigint;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "activity_gaps" jsonb;
