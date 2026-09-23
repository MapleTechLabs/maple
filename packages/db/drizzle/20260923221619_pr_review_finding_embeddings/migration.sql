CREATE TABLE "pr_review_finding_embeddings" (
	"finding_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"model" text NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pr_review_finding_embeddings_org_model_idx" ON "pr_review_finding_embeddings" ("org_id","model");