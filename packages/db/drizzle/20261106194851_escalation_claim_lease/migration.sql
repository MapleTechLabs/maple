-- metadata
ALTER TABLE "issue_escalations" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
