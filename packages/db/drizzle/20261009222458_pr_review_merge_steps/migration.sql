-- metadata
CREATE TABLE IF NOT EXISTS "pr_review_merge_steps" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"path" text,
	"status" text NOT NULL DEFAULT 'open',
	"done_by" text,
	"done_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"first_review_id" text NOT NULL,
	"last_review_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pr_review_merge_steps_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "pr_review_merge_steps_org_created_idx" ON "pr_review_merge_steps" USING btree ("org_id", "created_at");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "pr_review_merge_steps_pr_key_idx" ON "pr_review_merge_steps" USING btree ("repository_id", "number", "key");
