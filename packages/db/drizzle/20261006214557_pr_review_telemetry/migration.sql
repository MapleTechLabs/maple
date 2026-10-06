ALTER TABLE "pr_reviews" ADD COLUMN "telemetry_json" jsonb;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "post_merge_status" text;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "post_merge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "post_merge_json" jsonb;--> statement-breakpoint
CREATE INDEX "pr_reviews_post_merge_due_idx" ON "pr_reviews" ("post_merge_after") WHERE "post_merge_status" = 'waiting';