CREATE TABLE "railway_connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"workspace_names" text,
	"connected_by_user_id" text NOT NULL,
	"auth_failed_at" timestamp with time zone,
	"discovered_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "railway_environments" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_name" text NOT NULL,
	"environment_id" text NOT NULL,
	"environment_name" text NOT NULL,
	"services_json" text DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"watermark_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "railway_connections_org_idx" ON "railway_connections" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "railway_environments_org_env_idx" ON "railway_environments" ("org_id","environment_id");--> statement-breakpoint
CREATE INDEX "railway_environments_connection_idx" ON "railway_environments" ("connection_id");