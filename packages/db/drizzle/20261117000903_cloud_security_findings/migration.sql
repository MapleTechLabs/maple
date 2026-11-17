-- metadata
CREATE TABLE IF NOT EXISTS "cloud_security_findings" (
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"account_id" text NOT NULL,
	"region" text NOT NULL,
	"source" text NOT NULL,
	"finding_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_name" text,
	"occurrences" integer NOT NULL DEFAULT 1,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"detail" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cloud_security_findings_pkey" PRIMARY KEY ("org_id", "connection_id", "region", "source", "finding_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "cloud_security_service_states" (
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"region" text NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"cursor_at" timestamp with time zone,
	"window_ms" bigint,
	"last_error" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cloud_security_service_states_pkey" PRIMARY KEY ("org_id", "connection_id", "region", "source")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "aws_connections_org_id_idx" ON "aws_connections" USING btree ("org_id", "id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "cloud_security_findings_org_resource_idx" ON "cloud_security_findings" USING btree ("org_id", "resource_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "cloud_security_findings_org_status_idx" ON "cloud_security_findings" USING btree ("org_id", "status", "last_seen_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "cloud_security_service_states_org_idx" ON "cloud_security_service_states" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_findings" ADD CONSTRAINT "cloud_security_findings_ujhY2Pd3JWVy_fk" FOREIGN KEY ("org_id", "connection_id") REFERENCES "aws_connections" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" ADD CONSTRAINT "cloud_security_service_states_jHft8OtcW6A2_fk" FOREIGN KEY ("org_id", "connection_id") REFERENCES "aws_connections" ("org_id", "id") ON DELETE CASCADE;
