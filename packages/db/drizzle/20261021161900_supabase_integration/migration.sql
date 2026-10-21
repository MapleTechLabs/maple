-- metadata
CREATE TABLE IF NOT EXISTS "supabase_connections" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"source_id" text NOT NULL,
	"supabase_organization_id" text NOT NULL,
	"supabase_organization_slug" text NOT NULL,
	"supabase_organization_name" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"discovery_lease_until" timestamp with time zone,
	"last_discovery_at" timestamp with time zone,
	"last_discovery_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supabase_connections_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "supabase_projects" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_ref" text NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"status" text NOT NULL,
	"metrics_enabled" boolean NOT NULL DEFAULT true,
	"scrape_target_id" text,
	"log_drain_enabled" boolean NOT NULL DEFAULT false,
	"log_drain_id" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supabase_projects_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "supabase_connections_org_idx" ON "supabase_connections" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "supabase_connections_source_idx" ON "supabase_connections" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "supabase_projects_connection_ref_idx" ON "supabase_projects" USING btree ("connection_id", "project_ref");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "supabase_projects_org_idx" ON "supabase_projects" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_connections" ADD CONSTRAINT "supabase_connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_projects" ADD CONSTRAINT "supabase_projects_connection_id_supabase_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "supabase_connections" ("id") ON DELETE CASCADE;
