-- metadata
CREATE TABLE IF NOT EXISTS "vercel_connections" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"source_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_slug" text NOT NULL,
	"team_name" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"project_scope" text NOT NULL,
	"project_ids" jsonb NOT NULL DEFAULT '[]',
	"sampling_rate" double precision NOT NULL DEFAULT 1,
	"logs_enabled" boolean NOT NULL DEFAULT true,
	"traces_enabled" boolean NOT NULL DEFAULT true,
	"ai_gateway_enabled" boolean NOT NULL DEFAULT true,
	"speed_insights_enabled" boolean NOT NULL DEFAULT false,
	"web_analytics_enabled" boolean NOT NULL DEFAULT false,
	"audit_log_enabled" boolean NOT NULL DEFAULT false,
	"log_drain_id" text,
	"trace_drain_id" text,
	"ai_gateway_drain_id" text,
	"speed_insights_drain_id" text,
	"web_analytics_drain_id" text,
	"audit_log_drain_id" text,
	"log_drain_state" jsonb,
	"trace_drain_state" jsonb,
	"ai_gateway_drain_state" jsonb,
	"speed_insights_drain_state" jsonb,
	"web_analytics_drain_state" jsonb,
	"audit_log_drain_state" jsonb,
	"drain_key_hash" text,
	"auth_failed_at" timestamp with time zone,
	"discovered_at" timestamp with time zone,
	"deployments_watermark_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vercel_connections_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "vercel_deployments" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"url" text NOT NULL,
	"target" text,
	"state" text NOT NULL,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"creator" text,
	"error_code" text,
	"error_message" text,
	"created_at_vercel" timestamp with time zone NOT NULL,
	"building_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"inspector_url" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vercel_deployments_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "vercel_projects" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"framework" text,
	"production_deployment_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vercel_projects_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "vercel_connections_org_idx" ON "vercel_connections" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "vercel_connections_source_idx" ON "vercel_connections" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "vercel_deployments_org_deployment_idx" ON "vercel_deployments" USING btree ("org_id", "deployment_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "vercel_deployments_org_project_created_idx" ON "vercel_deployments" USING btree ("org_id", "project_id", "created_at_vercel");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "vercel_projects_org_project_idx" ON "vercel_projects" USING btree ("org_id", "project_id");
--> statement-breakpoint
-- metadata
-- Guarded: PR previews already applied an earlier version of this migration.
DO $$
BEGIN
	ALTER TABLE "vercel_connections" ADD CONSTRAINT "vercel_connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
