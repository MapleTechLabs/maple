-- metadata
CREATE TABLE IF NOT EXISTS "cloudflare_feature_settings" (
	"org_id" text NOT NULL,
	"http_traffic_enabled" boolean NOT NULL DEFAULT true,
	"firewall_enabled" boolean NOT NULL DEFAULT true,
	"dns_enabled" boolean NOT NULL DEFAULT true,
	"workers_enabled" boolean NOT NULL DEFAULT true,
	"queues_enabled" boolean NOT NULL DEFAULT true,
	"durable_objects_enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "cloudflare_feature_settings_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_connections" ADD COLUMN IF NOT EXISTS "metrics_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_connections" ADD COLUMN IF NOT EXISTS "events_enabled" boolean NOT NULL DEFAULT true;
