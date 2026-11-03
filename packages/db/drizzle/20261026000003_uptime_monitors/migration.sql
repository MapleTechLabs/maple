-- metadata
CREATE TABLE IF NOT EXISTS "uptime_monitor_states" (
	"monitor_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"consecutive_successes" integer NOT NULL DEFAULT 0,
	"status_changed_at" timestamp with time zone,
	"last_check_json" jsonb,
	"recent_json" jsonb NOT NULL,
	"last_ping_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uptime_monitor_states_pkey" PRIMARY KEY ("monitor_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "uptime_monitors" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"interval_seconds" integer NOT NULL DEFAULT 60,
	"failures_to_down" integer NOT NULL DEFAULT 2,
	"service_name" text,
	"alert_rule_id" text,
	"heartbeat_token" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uptime_monitors_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "uptime_monitor_states_org_idx" ON "uptime_monitor_states" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "uptime_monitors_enabled_kind_idx" ON "uptime_monitors" USING btree ("enabled", "kind");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "uptime_monitors_heartbeat_token_unq" ON "uptime_monitors" USING btree ("heartbeat_token");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "uptime_monitors_org_idx" ON "uptime_monitors" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "uptime_monitor_states" ADD CONSTRAINT "uptime_monitor_states_monitor_id_uptime_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "uptime_monitors" ("id") ON DELETE CASCADE;
