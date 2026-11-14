-- metadata
ALTER TABLE "cloudflare_analytics_state" ADD COLUMN IF NOT EXISTS "backoff_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloudflare_analytics_state" ADD COLUMN IF NOT EXISTS "backoff_streak" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloudflare_analytics_state" ADD COLUMN IF NOT EXISTS "backoff_reason" text;
