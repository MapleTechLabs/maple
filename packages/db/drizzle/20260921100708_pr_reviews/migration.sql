CREATE TABLE "pr_reviews" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"url" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"session_id" text,
	"report_json" jsonb,
	"check_run_url" text,
	"review_url" text,
	"publish_error" text,
	"error" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcs_repositories" ADD COLUMN "pr_review_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_reviews_repo_number_head_idx" ON "pr_reviews" ("repository_id","number","head_sha");--> statement-breakpoint
CREATE INDEX "pr_reviews_repo_number_idx" ON "pr_reviews" ("repository_id","number");--> statement-breakpoint
CREATE INDEX "pr_reviews_org_created_idx" ON "pr_reviews" ("org_id","created_at");