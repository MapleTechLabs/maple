-- metadata
CREATE TABLE IF NOT EXISTS "alert_maintenance_windows" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"reason" text,
	"matchers_json" jsonb NOT NULL,
	"schedule_json" jsonb NOT NULL,
	"exclude_from_baselines" boolean NOT NULL DEFAULT true,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "alert_maintenance_windows_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_silences" ADD COLUMN IF NOT EXISTS "maintenance_window_id" text;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_maintenance_windows_enabled_idx" ON "alert_maintenance_windows" USING btree ("enabled", "id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_maintenance_windows_org_idx" ON "alert_maintenance_windows" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "alert_silences_maintenance_occurrence_idx" ON "alert_silences" USING btree ("maintenance_window_id", "starts_at") WHERE "maintenance_window_id" IS NOT NULL;
