CREATE TABLE "investigations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" text DEFAULT 'investigating' NOT NULL,
	"seeded_by" text DEFAULT 'user' NOT NULL,
	"subject_json" jsonb NOT NULL,
	"incident_kind" text,
	"incident_id" text,
	"issue_id" text,
	"report_json" jsonb,
	"severity" text,
	"confidence" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"diagnosed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "investigations_incident_idx" ON "investigations" USING btree ("org_id","incident_kind","incident_id") WHERE "investigations"."incident_id" is not null;--> statement-breakpoint
CREATE INDEX "investigations_org_created_idx" ON "investigations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "investigations_org_issue_idx" ON "investigations" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "investigations_org_status_idx" ON "investigations" USING btree ("org_id","status");