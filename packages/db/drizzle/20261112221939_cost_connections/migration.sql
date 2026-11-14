-- metadata
CREATE TABLE IF NOT EXISTS "cost_connections" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"account_id" text NOT NULL,
	"account_label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "cost_connections_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "cost_connections_org_provider_idx" ON "cost_connections" USING btree ("org_id", "provider");
