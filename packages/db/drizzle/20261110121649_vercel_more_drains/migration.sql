-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "speed_insights_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "web_analytics_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "audit_log_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "speed_insights_drain_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "web_analytics_drain_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "audit_log_drain_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "speed_insights_drain_state" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "web_analytics_drain_state" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "audit_log_drain_state" jsonb;
