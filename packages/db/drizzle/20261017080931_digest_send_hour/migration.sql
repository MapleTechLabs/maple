-- metadata
ALTER TABLE "digest_subscriptions" ADD COLUMN IF NOT EXISTS "send_hour" integer NOT NULL DEFAULT 9;
