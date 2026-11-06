-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_org_settings" (
	"org_id" text NOT NULL,
	"monthly_spend_limit_usd" integer NOT NULL,
	"discovery_model" text NOT NULL,
	"validation_model" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_audit_org_settings_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_org_reservations" ADD COLUMN IF NOT EXISTS "cost_usd" double precision;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_runs" ADD COLUMN IF NOT EXISTS "discovery_model" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_runs" ADD COLUMN IF NOT EXISTS "validation_model" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_targets" ADD COLUMN IF NOT EXISTS "discovery_model" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_targets" ADD COLUMN IF NOT EXISTS "validation_model" text;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_org_reservations_org_created_idx" ON "security_audit_org_reservations" USING btree ("org_id", "created_at");
