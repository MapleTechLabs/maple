-- metadata
CREATE TABLE IF NOT EXISTS "alert_member_notifications" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"attempt_number" integer NOT NULL DEFAULT 1,
	"scheduled_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"payload_json" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"error_message" text,
	"attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alert_member_notifications_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "alert_member_notifications_dedupe_idx" ON "alert_member_notifications" USING btree ("dedupe_key");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_member_notifications_due_idx" ON "alert_member_notifications" USING btree ("status", "scheduled_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_member_notifications_org_incident_idx" ON "alert_member_notifications" USING btree ("org_id", "incident_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_member_notifications" ADD CONSTRAINT "alert_member_notifications_incident_id_alert_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "alert_incidents" ("id") ON DELETE CASCADE;
