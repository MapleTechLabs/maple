CREATE TABLE "agent_feedback" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"impact" text,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"related_to" text,
	"agent_type" text NOT NULL,
	"agent_name" text,
	"agent_model" text,
	"agent_version" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_feedback_org_created_idx" ON "agent_feedback" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_feedback_kind_created_idx" ON "agent_feedback" ("kind","created_at");