-- metadata
CREATE TABLE IF NOT EXISTS "device_policy_findings" (
	"org_id" text NOT NULL,
	"source" text NOT NULL,
	"connection_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"resolution" text,
	"critical" boolean NOT NULL,
	"platform" text,
	"failing_device_count" integer NOT NULL,
	"passing_device_count" integer,
	"failing_devices" jsonb NOT NULL,
	"counted_at" timestamp with time zone,
	"url" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_policy_findings_pkey" PRIMARY KEY ("org_id", "source", "connection_id", "policy_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "device_vulnerability_findings" (
	"org_id" text NOT NULL,
	"source" text NOT NULL,
	"connection_id" text NOT NULL,
	"cve" text NOT NULL,
	"cvss_score" double precision,
	"epss_probability" double precision,
	"known_exploited" boolean,
	"details_link" text,
	"device_count" integer NOT NULL,
	"software" jsonb NOT NULL,
	"url" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_vulnerability_findings_pkey" PRIMARY KEY ("org_id", "source", "connection_id", "cve")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "findings_lease_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "findings_hold_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "findings_synced_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "findings_error" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "findings_error_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "device_count" integer;
