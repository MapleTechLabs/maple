CREATE TABLE "pr_review_findings" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"review_id" text NOT NULL,
	"handle" text NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"comment_id" text,
	"resolved_sha" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcs_repositories" ADD COLUMN "pr_review_config" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_findings_pr_handle_idx" ON "pr_review_findings" ("repository_id","number","handle");--> statement-breakpoint
CREATE INDEX "pr_review_findings_org_idx" ON "pr_review_findings" ("org_id");