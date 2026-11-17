-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "audit_trail_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "audit_trail_changed_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "audit_last_received_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "audit_last_error" text;
