-- metadata
ALTER TABLE "vercel_deployments" ADD COLUMN IF NOT EXISTS "error_message" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_deployments" ADD COLUMN IF NOT EXISTS "building_at" timestamp with time zone;
