CREATE TABLE "gcp_resources" (
	"connector_id" text,
	"org_id" text NOT NULL,
	"name" text,
	"asset_type" text NOT NULL,
	"project_id" text NOT NULL,
	"location" text,
	"display_name" text,
	"state" text,
	"labels" jsonb NOT NULL,
	"resource_created_at" timestamp with time zone,
	"resource_updated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gcp_resources_pkey" PRIMARY KEY("connector_id","name")
);
--> statement-breakpoint
ALTER TABLE "gcp_connectors" ADD COLUMN "metrics_watermark_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gcp_connectors" ADD COLUMN "last_metrics_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gcp_connectors" ADD COLUMN "last_metrics_error" text;--> statement-breakpoint
ALTER TABLE "gcp_connectors" ADD COLUMN "metrics_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gcp_connectors" ADD COLUMN "resources_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gcp_connectors" ADD COLUMN "last_resources_error" text;--> statement-breakpoint
ALTER TABLE "gcp_resources" ADD CONSTRAINT "gcp_resources_connector_id_gcp_connectors_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "gcp_connectors"("id") ON DELETE CASCADE;