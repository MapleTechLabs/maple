-- metadata
CREATE TABLE IF NOT EXISTS "cloudflare_zone_settings" (
	"org_id" text NOT NULL,
	"account_id" text NOT NULL,
	"watch_new_zones" boolean NOT NULL DEFAULT true,
	"zone_overrides" jsonb NOT NULL DEFAULT '{}',
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "cloudflare_zone_settings_pkey" PRIMARY KEY ("org_id", "account_id")
);
