-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "last_rejected_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "last_rejection" text;
