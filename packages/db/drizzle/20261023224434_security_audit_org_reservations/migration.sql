-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_org_reservations" (
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"org_id" text NOT NULL,
	"period" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_audit_org_reservations_pkey" PRIMARY KEY ("run_id", "agent_id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "security_audit_org_reservations_org_idx" ON "security_audit_org_reservations" USING btree ("org_id", "period");
