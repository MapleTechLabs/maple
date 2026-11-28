-- metadata
ALTER TABLE "cloud_security_findings" DROP CONSTRAINT IF EXISTS "cloud_security_findings_ujhY2Pd3JWVy_fk";
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" DROP CONSTRAINT IF EXISTS "cloud_security_service_states_jHft8OtcW6A2_fk";
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_findings" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'aws';
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_findings" ADD COLUMN IF NOT EXISTS "aws_connection_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_findings" ADD COLUMN IF NOT EXISTS "gcp_connector_id" text;
--> statement-breakpoint
-- Every existing row is an AWS connection's: its owner column takes the connection id.
UPDATE "cloud_security_findings" SET "aws_connection_id" = "connection_id" WHERE "provider" = 'aws' AND "aws_connection_id" IS NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'aws';
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" ADD COLUMN IF NOT EXISTS "aws_connection_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" ADD COLUMN IF NOT EXISTS "gcp_connector_id" text;
--> statement-breakpoint
-- Every existing row is an AWS connection's: its owner column takes the connection id.
UPDATE "cloud_security_service_states" SET "aws_connection_id" = "connection_id" WHERE "provider" = 'aws' AND "aws_connection_id" IS NULL;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "gcp_connectors_org_id_idx" ON "gcp_connectors" USING btree ("org_id", "id");
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_findings" ADD CONSTRAINT "cloud_security_findings_69zKr87rI454_fk" FOREIGN KEY ("org_id", "aws_connection_id") REFERENCES "aws_connections" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_findings" ADD CONSTRAINT "cloud_security_findings_oKskFMtF9bGO_fk" FOREIGN KEY ("org_id", "gcp_connector_id") REFERENCES "gcp_connectors" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" ADD CONSTRAINT "cloud_security_service_states_g2xdPt2xNOTa_fk" FOREIGN KEY ("org_id", "aws_connection_id") REFERENCES "aws_connections" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "cloud_security_service_states" ADD CONSTRAINT "cloud_security_service_states_ilcqOYyxZst6_fk" FOREIGN KEY ("org_id", "gcp_connector_id") REFERENCES "gcp_connectors" ("org_id", "id") ON DELETE CASCADE;
