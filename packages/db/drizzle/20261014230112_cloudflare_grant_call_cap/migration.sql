-- metadata
ALTER TABLE "cloudflare_analytics_state" ADD COLUMN IF NOT EXISTS "grant_call_cap" integer;
