-- metadata
ALTER TABLE "security_audit_findings" ADD COLUMN IF NOT EXISTS "status_reason" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_findings" ADD COLUMN IF NOT EXISTS "status_changed_by" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_findings" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
