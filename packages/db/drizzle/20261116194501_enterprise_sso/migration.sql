-- metadata
CREATE TABLE IF NOT EXISTS "org_directory_groups" (
	"org_id" text NOT NULL,
	"directory_id" text NOT NULL,
	"group_id" text NOT NULL,
	"display_name" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "org_directory_groups_pkey" PRIMARY KEY ("directory_id", "group_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "org_sso_connections" (
	"org_id" text NOT NULL,
	"clerk_connection_id" text NOT NULL,
	"clerk_directory_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_sso_connections_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "org_sso_domains" (
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"challenge" text NOT NULL,
	"status" text NOT NULL,
	"clerk_domain_id" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "org_sso_domains_pkey" PRIMARY KEY ("org_id", "domain")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "org_directory_groups_org_idx" ON "org_directory_groups" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "org_sso_connections_connection_unq" ON "org_sso_connections" USING btree ("clerk_connection_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "org_sso_connections_directory_unq" ON "org_sso_connections" USING btree ("clerk_directory_id");
