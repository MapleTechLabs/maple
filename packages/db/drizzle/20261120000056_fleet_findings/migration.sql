-- metadata
CREATE TABLE IF NOT EXISTS "fleet_policy_findings" (
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"policy_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"resolution" text,
	"critical" boolean NOT NULL,
	"platform" text,
	"failing_host_count" integer NOT NULL,
	"passing_host_count" integer NOT NULL,
	"failing_hosts" jsonb NOT NULL,
	"counted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_policy_findings_pkey" PRIMARY KEY ("org_id", "connection_id", "policy_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "fleet_vulnerability_findings" (
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"cve" text NOT NULL,
	"cvss_score" double precision,
	"epss_probability" double precision,
	"known_exploited" boolean,
	"details_link" text,
	"host_count" integer NOT NULL,
	"software" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_vulnerability_findings_pkey" PRIMARY KEY ("org_id", "connection_id", "cve")
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
ALTER TABLE "fleet_connections" ADD COLUMN IF NOT EXISTS "host_count" integer;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_connections_org_id_idx" ON "fleet_connections" USING btree ("org_id", "id");
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_policy_findings" ADD CONSTRAINT "fleet_policy_findings_My7oEJHHBVUy_fk" FOREIGN KEY ("org_id", "connection_id") REFERENCES "fleet_connections" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "fleet_vulnerability_findings" ADD CONSTRAINT "fleet_vulnerability_findings_chCivlNtIwmU_fk" FOREIGN KEY ("org_id", "connection_id") REFERENCES "fleet_connections" ("org_id", "id") ON DELETE CASCADE;
