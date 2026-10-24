-- metadata
ALTER TABLE "security_audit_runs" ADD COLUMN IF NOT EXISTS "execution_profile" jsonb;
