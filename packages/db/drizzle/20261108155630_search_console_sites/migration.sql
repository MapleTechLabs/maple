-- metadata
CREATE TABLE IF NOT EXISTS "search_console_sites" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"oauth_connection_id" text NOT NULL,
	"site_url" text NOT NULL,
	"permission_level" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"watermark_date" text,
	"backfill_date" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "search_console_sites_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "search_console_sites_connection_idx" ON "search_console_sites" USING btree ("oauth_connection_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "search_console_sites_org_site_idx" ON "search_console_sites" USING btree ("org_id", "site_url");
--> statement-breakpoint
-- metadata
ALTER TABLE "search_console_sites" ADD CONSTRAINT "search_console_sites_jBAHYyW36dnu_fk" FOREIGN KEY ("oauth_connection_id") REFERENCES "oauth_connections" ("id") ON DELETE CASCADE;
