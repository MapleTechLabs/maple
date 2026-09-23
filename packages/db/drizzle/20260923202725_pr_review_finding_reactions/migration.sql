ALTER TABLE "pr_review_findings" ADD COLUMN "reactions_up" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_review_findings" ADD COLUMN "reactions_down" integer DEFAULT 0 NOT NULL;