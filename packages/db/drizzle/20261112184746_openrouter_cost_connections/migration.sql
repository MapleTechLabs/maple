-- metadata
CREATE TABLE IF NOT EXISTS "openrouter_cost_connections" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_tag" text NOT NULL,
	"key_label" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "openrouter_cost_connections_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "openrouter_cost_connections_org_idx" ON "openrouter_cost_connections" USING btree ("org_id");
