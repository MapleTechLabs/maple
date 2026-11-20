-- metadata
CREATE TABLE IF NOT EXISTS "fleet_connections" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"base_url" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"organization_name" text,
	"api_user_name" text,
	"api_user_role" text,
	"server_version" text,
	"license_tier" text,
	"connected_by_user_id" text NOT NULL,
	"auth_failed_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_connections_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_connections_org_idx" ON "fleet_connections" USING btree ("org_id");
