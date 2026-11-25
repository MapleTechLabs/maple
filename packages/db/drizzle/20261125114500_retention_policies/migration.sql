-- metadata
CREATE TABLE IF NOT EXISTS "org_retention_policies" (
	"org_id" text NOT NULL,
	"retention_days" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "org_retention_policies_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "retention_days" jsonb NOT NULL DEFAULT '{}'::jsonb;
