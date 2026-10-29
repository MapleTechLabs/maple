-- metadata
CREATE TABLE IF NOT EXISTS "status_page_cleanups" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"page_id" text NOT NULL,
	"slug" text NOT NULL,
	"delete_snapshot" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_cleanups_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "status_page_components" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"page_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"group_name" text,
	"position" integer NOT NULL DEFAULT 0,
	"monitor_id" text,
	"manual_status" text,
	"show_uptime" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_components_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "status_page_incident_components" (
	"incident_id" text NOT NULL,
	"component_id" text NOT NULL,
	"org_id" text NOT NULL,
	CONSTRAINT "status_page_incident_components_pk" PRIMARY KEY ("incident_id", "component_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "status_page_incident_updates" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"created_by" text,
	"overlay_entry_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_incident_updates_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "status_page_incidents" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"page_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"impact" text NOT NULL,
	"status" text NOT NULL,
	"published" boolean NOT NULL DEFAULT true,
	"alert_incident_id" text,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_incidents_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "status_pages" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"website_url" text,
	"logo_url" text,
	"brand_color" text,
	"show_powered_by" boolean NOT NULL DEFAULT true,
	"auto_incidents" text NOT NULL DEFAULT 'off',
	"break_glass_token_sha256" text,
	"break_glass_token_suffix" text,
	"revision" bigint NOT NULL DEFAULT 1,
	"published_revision" bigint NOT NULL DEFAULT 0,
	"published_at" timestamp with time zone,
	"last_publish_error" text,
	"published_hash" text,
	"publish_attempted_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_pages_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "uptime_monitor_daily" (
	"monitor_id" text NOT NULL,
	"day" text NOT NULL,
	"org_id" text NOT NULL,
	"checks" integer NOT NULL DEFAULT 0,
	"failures" integer NOT NULL DEFAULT 0,
	"down_checks" integer NOT NULL DEFAULT 0,
	"last_check_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uptime_monitor_daily_pk" PRIMARY KEY ("monitor_id", "day")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_cleanups_created_idx" ON "status_page_cleanups" USING btree ("created_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_components_monitor_idx" ON "status_page_components" USING btree ("monitor_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_components_page_idx" ON "status_page_components" USING btree ("page_id", "position");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incident_components_component_idx" ON "status_page_incident_components" USING btree ("component_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incident_updates_incident_idx" ON "status_page_incident_updates" USING btree ("incident_id", "created_at");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_page_incident_updates_overlay_unq" ON "status_page_incident_updates" USING btree ("overlay_entry_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incidents_alert_idx" ON "status_page_incidents" USING btree ("alert_incident_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incidents_page_idx" ON "status_page_incidents" USING btree ("page_id", "started_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_pages_org_idx" ON "status_pages" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_pages_slug_unq" ON "status_pages" USING btree ("slug");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_pages_unpublished_idx" ON "status_pages" USING btree ("revision", "published_revision") WHERE revision > published_revision;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "uptime_monitor_daily_org_idx" ON "uptime_monitor_daily" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_components" ADD CONSTRAINT "status_page_components_monitor_id_uptime_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "uptime_monitors" ("id") ON DELETE SET NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_components" ADD CONSTRAINT "status_page_components_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "status_pages" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_incident_components" ADD CONSTRAINT "status_page_incident_components_Bnqlt6wwKJty_fk" FOREIGN KEY ("component_id") REFERENCES "status_page_components" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_incident_components" ADD CONSTRAINT "status_page_incident_components_tBn6mEz4FenY_fk" FOREIGN KEY ("incident_id") REFERENCES "status_page_incidents" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_incident_updates" ADD CONSTRAINT "status_page_incident_updates_3LDDUAhznHPM_fk" FOREIGN KEY ("incident_id") REFERENCES "status_page_incidents" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_incidents" ADD CONSTRAINT "status_page_incidents_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "status_pages" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "uptime_monitor_daily" ADD CONSTRAINT "uptime_monitor_daily_monitor_id_uptime_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "uptime_monitors" ("id") ON DELETE CASCADE;
