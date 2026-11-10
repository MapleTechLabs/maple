-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "ai_gateway_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "ai_gateway_drain_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "vercel_connections" ADD COLUMN IF NOT EXISTS "ai_gateway_drain_state" jsonb;
