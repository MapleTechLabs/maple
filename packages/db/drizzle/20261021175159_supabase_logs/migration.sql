-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_watermark_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_boundary_ids" jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_lease_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_last_polled_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD COLUMN IF NOT EXISTS "logs_error" text;
