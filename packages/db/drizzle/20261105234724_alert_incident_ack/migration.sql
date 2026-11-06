-- metadata
CREATE TABLE IF NOT EXISTS "alert_incident_events" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text,
	"source" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alert_incident_events_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_by_user_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_by_name" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_via" text;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_incident_events_incident_idx" ON "alert_incident_events" USING btree ("org_id", "incident_id", "created_at");
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incident_events" ADD CONSTRAINT "alert_incident_events_incident_id_alert_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "alert_incidents" ("id") ON DELETE CASCADE;
