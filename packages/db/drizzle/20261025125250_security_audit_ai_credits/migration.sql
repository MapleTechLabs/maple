-- metadata
DROP INDEX IF EXISTS "security_audit_org_reservations_org_idx";
--> statement-breakpoint
-- destructive
ALTER TABLE "security_audit_org_reservations" DROP COLUMN IF EXISTS "period";
--> statement-breakpoint
-- destructive
DROP TABLE IF EXISTS "security_audit_org_usage";
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_org_reservations" ADD COLUMN IF NOT EXISTS "sandbox_fee_usd" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
-- metadata
ALTER TABLE "security_audit_runs" ADD COLUMN IF NOT EXISTS "sandbox_usd" double precision NOT NULL DEFAULT 0;
