CREATE TABLE "pr_review_edits" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"reply_id" text NOT NULL,
	"seq" integer NOT NULL,
	"path" text NOT NULL,
	"old_text" text NOT NULL,
	"new_text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
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
	"reactions_up" integer DEFAULT 0 NOT NULL,
	"reactions_down" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_review_replies" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"comment_id" text NOT NULL,
	"surface" text NOT NULL,
	"thread_root_id" text,
	"author_login" text NOT NULL,
	"command" text NOT NULL,
	"head_sha" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"session_id" text,
	"reply_url" text,
	"commit_sha" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcs_repositories" ADD COLUMN "pr_review_config" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_edits_reply_seq_idx" ON "pr_review_edits" ("reply_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_findings_pr_handle_idx" ON "pr_review_findings" ("repository_id","number","handle");--> statement-breakpoint
CREATE INDEX "pr_review_findings_org_idx" ON "pr_review_findings" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_replies_repo_comment_idx" ON "pr_review_replies" ("repository_id","comment_id");--> statement-breakpoint
CREATE INDEX "pr_review_replies_org_created_idx" ON "pr_review_replies" ("org_id","created_at");