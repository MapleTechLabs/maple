-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_events" (
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"org_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"agent_id" text,
	"outcome" text,
	"detail" jsonb NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	CONSTRAINT "security_audit_events_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_findings" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"target_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"verdict" text NOT NULL,
	"overall_severity" text,
	"record" jsonb NOT NULL,
	"status" text NOT NULL DEFAULT 'open',
	"first_seen_run_id" text NOT NULL,
	"last_seen_run_id" text NOT NULL,
	"first_seen_ref" text NOT NULL,
	"last_seen_ref" text NOT NULL,
	"fixed_run_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_audit_findings_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_run_findings" (
	"run_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"org_id" text NOT NULL,
	"verdict" text NOT NULL,
	"overall_severity" text,
	"record" jsonb NOT NULL,
	CONSTRAINT "security_audit_run_findings_pkey" PRIMARY KEY ("run_id", "fingerprint")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_runs" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"profile" text NOT NULL,
	"scope_paths" jsonb NOT NULL,
	"budget" integer,
	"metadata" jsonb,
	"status" text NOT NULL DEFAULT 'in_progress',
	"incomplete_reason" text,
	"architecture_md" text,
	"reports" jsonb,
	"invocations_spent" integer NOT NULL DEFAULT 0,
	"input_tokens" bigint NOT NULL DEFAULT 0,
	"output_tokens" bigint NOT NULL DEFAULT 0,
	"cost_usd" double precision,
	"workflow_instance_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "security_audit_runs_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_targets" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"repository" text NOT NULL,
	"vcs_repository_id" text,
	"branch" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"profile" text NOT NULL DEFAULT 'deep',
	"scope_paths" jsonb NOT NULL,
	"slice_interval_hours" integer,
	"revalidate_on_push" boolean NOT NULL DEFAULT false,
	"budget_per_run" integer,
	"monthly_invocation_budget" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_audit_targets_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_units" (
	"run_id" text NOT NULL,
	"coverage_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL,
	"wave" integer NOT NULL,
	"agent_id" text,
	"unit" jsonb NOT NULL,
	CONSTRAINT "security_audit_units_pkey" PRIMARY KEY ("run_id", "coverage_id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_events_run_at_idx" ON "security_audit_events" USING btree ("run_id", "at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_findings_org_created_idx" ON "security_audit_findings" USING btree ("org_id", "created_at");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "security_audit_findings_target_fingerprint_idx" ON "security_audit_findings" USING btree ("target_id", "fingerprint");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_runs_org_started_idx" ON "security_audit_runs" USING btree ("org_id", "started_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_runs_target_started_idx" ON "security_audit_runs" USING btree ("target_id", "started_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_targets_org_created_idx" ON "security_audit_targets" USING btree ("org_id", "created_at");
