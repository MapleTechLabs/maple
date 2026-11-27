-- metadata
CREATE TABLE IF NOT EXISTS "ai_evaluation_runs" (
	"org_id" text NOT NULL,
	"scorer" text NOT NULL,
	"cursor_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_evaluation_runs_pkey" PRIMARY KEY ("org_id", "scorer")
);
