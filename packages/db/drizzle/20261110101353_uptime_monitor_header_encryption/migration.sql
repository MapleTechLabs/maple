-- metadata
ALTER TABLE "uptime_monitors" ADD COLUMN IF NOT EXISTS "headers_ciphertext" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "uptime_monitors" ADD COLUMN IF NOT EXISTS "headers_iv" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "uptime_monitors" ADD COLUMN IF NOT EXISTS "headers_tag" text;
