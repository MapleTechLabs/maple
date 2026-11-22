-- metadata
CREATE TABLE IF NOT EXISTS "onboarding_agent_runs" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"stages" jsonb NOT NULL,
	"service_names" jsonb NOT NULL,
	"trace_id" text,
	"last_reported_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_agent_runs_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "onboarding_agent_runs_org_user_created_idx" ON "onboarding_agent_runs" USING btree ("org_id", "user_id", "created_at");
