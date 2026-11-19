-- metadata
CREATE TABLE IF NOT EXISTS "cost_source_requests" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cost_source_requests_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "cost_source_requests_org_idx" ON "cost_source_requests" USING btree ("org_id");
