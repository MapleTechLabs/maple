CREATE TABLE "cancellation_reviews" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"subscription_started_at" bigint NOT NULL,
	"snapshot_json" jsonb,
	"rule_reason" text,
	"assessment_json" jsonb,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_reviews_subscription_idx" ON "cancellation_reviews" ("org_id","plan_id","subscription_started_at");