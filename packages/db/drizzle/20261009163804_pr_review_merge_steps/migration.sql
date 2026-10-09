CREATE TABLE "pr_review_merge_steps" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"path" text,
	"status" text DEFAULT 'open' NOT NULL,
	"done_by" text,
	"done_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"first_review_id" text NOT NULL,
	"last_review_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_merge_steps_pr_key_idx" ON "pr_review_merge_steps" ("repository_id","number","key");--> statement-breakpoint
CREATE INDEX "pr_review_merge_steps_org_created_idx" ON "pr_review_merge_steps" ("org_id","created_at");