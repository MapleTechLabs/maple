-- metadata
ALTER TABLE "planetscale_databases" ADD COLUMN IF NOT EXISTS "webhook_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_databases" ADD COLUMN IF NOT EXISTS "webhook_secret_ciphertext" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_databases" ADD COLUMN IF NOT EXISTS "webhook_secret_iv" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_databases" ADD COLUMN IF NOT EXISTS "webhook_secret_tag" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_databases" ADD COLUMN IF NOT EXISTS "webhook_error" text;
