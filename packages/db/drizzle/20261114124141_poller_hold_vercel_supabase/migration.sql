-- metadata
ALTER TABLE "supabase_project_insights" ADD COLUMN IF NOT EXISTS "hold_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_hold_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "hold_until" timestamp with time zone;
--> statement-breakpoint
-- Holds used to live in the lease column; move a live one (further ahead than a lease) so a deploy does not lift it.
UPDATE "vercel_connections" SET "hold_until" = "lease_until", "lease_until" = NULL WHERE "lease_until" > now() + interval '4 minutes';
--> statement-breakpoint
UPDATE "supabase_projects" SET "logs_hold_until" = "logs_lease_until", "logs_lease_until" = NULL WHERE "logs_lease_until" > now() + interval '3 minutes';
