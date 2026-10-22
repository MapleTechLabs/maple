-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "metric_stream" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "stream_secret_ciphertext" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "stream_secret_iv" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "stream_secret_tag" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "stream_secret_hash" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "stream_last_received_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "stream_last_error" text;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "aws_connections_stream_secret_hash_idx" ON "aws_connections" USING btree ("stream_secret_hash");
