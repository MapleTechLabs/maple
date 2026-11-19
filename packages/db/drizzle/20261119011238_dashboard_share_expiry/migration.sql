-- metadata
ALTER TABLE "dashboard_shares" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
