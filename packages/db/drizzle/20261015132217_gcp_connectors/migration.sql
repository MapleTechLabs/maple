-- metadata
CREATE TABLE IF NOT EXISTS "gcp_connectors" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"project_id" text NOT NULL,
	"logs_enabled" boolean NOT NULL DEFAULT true,
	"metrics_enabled" boolean NOT NULL DEFAULT false,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"secret_hash" text NOT NULL,
	"last_received_at" timestamp with time zone,
	"last_error" text,
	"applied_logs_enabled" boolean,
	"applied_metrics_enabled" boolean,
	"setup_reported_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gcp_connectors_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "gcp_connectors_org_scope_idx" ON "gcp_connectors" USING btree ("org_id", "scope_type", "scope_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "gcp_connectors_secret_hash_unique" ON "gcp_connectors" USING btree ("secret_hash");
