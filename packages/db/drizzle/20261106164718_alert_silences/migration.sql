-- metadata
CREATE TABLE IF NOT EXISTS "alert_silences" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"reason" text NOT NULL,
	"matchers_json" jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "alert_silences_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_delivery_events" ADD COLUMN IF NOT EXISTS "silence_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "silence_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "silenced_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_silences_org_ends_idx" ON "alert_silences" USING btree ("org_id", "ends_at");
