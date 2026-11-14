-- metadata
ALTER TABLE "planetscale_poll_state" ADD COLUMN IF NOT EXISTS "hold_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "railway_connections" ADD COLUMN IF NOT EXISTS "hold_until" timestamp with time zone;
--> statement-breakpoint
-- A Railway hold used to live in lease_until; move a live one so a deploy does not lift it.
UPDATE "railway_connections" SET "hold_until" = "lease_until", "lease_until" = NULL WHERE "lease_until" > now() + interval '4 minutes';
