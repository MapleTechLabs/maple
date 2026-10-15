-- metadata
CREATE TABLE IF NOT EXISTS "gcp_resources" (
	"connector_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"asset_type" text NOT NULL,
	"project_id" text NOT NULL,
	"location" text,
	"display_name" text,
	"state" text,
	"labels" jsonb NOT NULL,
	"resource_created_at" timestamp with time zone,
	"resource_updated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gcp_resources_pkey" PRIMARY KEY ("connector_id", "name")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "metrics_watermark_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "last_metrics_received_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "last_metrics_error" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "metrics_lease_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "resources_synced_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "last_resources_error" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_resources" ADD CONSTRAINT "gcp_resources_connector_id_gcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "gcp_connectors" ("id") ON DELETE CASCADE;
