-- metadata
CREATE TABLE IF NOT EXISTS "status_page_custom_domains" (
	"page_id" text NOT NULL,
	"org_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text NOT NULL,
	"cloudflare_hostname_id" text,
	"cloudflare_route_id" text,
	"dns_records" jsonb NOT NULL DEFAULT '[]',
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_custom_domains_pkey" PRIMARY KEY ("page_id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_cleanups" ADD COLUMN IF NOT EXISTS "hostname" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_cleanups" ADD COLUMN IF NOT EXISTS "cloudflare_hostname_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_cleanups" ADD COLUMN IF NOT EXISTS "cloudflare_route_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "logo_dark_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "favicon_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "support_url" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'public';
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "password_hash" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_cleanups" ALTER COLUMN "slug" DROP NOT NULL;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_custom_domains_checked_idx" ON "status_page_custom_domains" USING btree ("last_checked_at");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_page_custom_domains_hostname_unq" ON "status_page_custom_domains" USING btree ("hostname");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_custom_domains_org_idx" ON "status_page_custom_domains" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incidents_open_maintenance_idx" ON "status_page_incidents" USING btree ("scheduled_start") WHERE "kind" = 'maintenance' and "resolved_at" is null;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_custom_domains" ADD CONSTRAINT "status_page_custom_domains_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "status_pages" ("id") ON DELETE CASCADE;
