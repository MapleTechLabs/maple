-- metadata
CREATE TABLE IF NOT EXISTS "security_audit_org_usage" (
	"org_id" text NOT NULL,
	"period" text NOT NULL,
	"invocations_spent" integer NOT NULL DEFAULT 0,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_audit_org_usage_pkey" PRIMARY KEY ("org_id", "period")
);
