-- metadata
ALTER TABLE "security_audit_findings" ADD COLUMN IF NOT EXISTS "estimated_severity" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_run_findings" ADD COLUMN IF NOT EXISTS "estimated_severity" text;
