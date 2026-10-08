CREATE TABLE "gcp_connectors" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"project_id" text NOT NULL,
	"logs_enabled" boolean DEFAULT true NOT NULL,
	"metrics_enabled" boolean DEFAULT false NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"secret_hash" text NOT NULL,
	"last_received_at" timestamp with time zone,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gcp_connectors_org_scope_idx" ON "gcp_connectors" ("org_id","scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gcp_connectors_secret_hash_unique" ON "gcp_connectors" ("secret_hash");