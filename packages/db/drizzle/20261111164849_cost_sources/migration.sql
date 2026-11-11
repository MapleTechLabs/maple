-- metadata
CREATE TABLE IF NOT EXISTS "cost_sources" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"connection_ref" text NOT NULL,
	"account_id" text NOT NULL,
	"watermark_date" text,
	"backfill_date" text,
	"last_synced_at" timestamp with time zone,
	"last_settled_at" timestamp with time zone,
	"last_error" text,
	"last_error_reason" text,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"requests_month" text,
	"requests_count" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cost_sources_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "cost_sources_org_provider_ref_idx" ON "cost_sources" USING btree ("org_id", "provider", "connection_ref");
