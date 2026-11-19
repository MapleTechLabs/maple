-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "activity_cursor" bigint;
