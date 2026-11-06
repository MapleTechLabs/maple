-- metadata
CREATE TABLE IF NOT EXISTS "alert_escalation_runs" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"chain_name" text NOT NULL,
	"severity" text NOT NULL,
	"steps_json" jsonb NOT NULL,
	"repeat_count" integer NOT NULL,
	"step_index" integer NOT NULL DEFAULT 0,
	"pass_index" integer NOT NULL DEFAULT 0,
	"next_step_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"steps_sent" integer NOT NULL DEFAULT 0,
	"last_step_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alert_escalation_runs_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "escalation_chains" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps_json" jsonb NOT NULL,
	"repeat_count" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "escalation_chains_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_escalation_runs_live_idx" ON "alert_escalation_runs" USING btree ("status", "next_step_at") WHERE "status" in ('active', 'acknowledged');
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "alert_escalation_runs_live_incident_idx" ON "alert_escalation_runs" USING btree ("incident_id") WHERE "status" IN ('active', 'acknowledged');
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_escalation_runs_org_incident_idx" ON "alert_escalation_runs" USING btree ("org_id", "incident_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "escalation_chains_org_idx" ON "escalation_chains" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_escalation_runs" ADD CONSTRAINT "alert_escalation_runs_incident_id_alert_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "alert_incidents" ("id") ON DELETE CASCADE;
