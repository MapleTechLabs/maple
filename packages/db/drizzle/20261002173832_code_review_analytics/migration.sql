DROP INDEX "pr_review_findings_org_idx";--> statement-breakpoint
ALTER TABLE "pr_review_settings" ADD COLUMN "defaults" jsonb;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "author_login" text;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "pr_review_findings_org_created_idx" ON "pr_review_findings" ("org_id","created_at");