-- metadata
CREATE TABLE IF NOT EXISTS "alert_linear_issues" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"linear_team_id" text NOT NULL,
	"linear_issue_id" text NOT NULL,
	"linear_identifier" text NOT NULL,
	"linear_url" text NOT NULL,
	"incident_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alert_linear_issues_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_linear_issues_org_idx" ON "alert_linear_issues" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "alert_linear_issues_thread_idx" ON "alert_linear_issues" USING btree ("destination_id", "thread_key");
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_linear_issues" ADD CONSTRAINT "alert_linear_issues_destination_id_alert_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "alert_destinations" ("id") ON DELETE CASCADE;
