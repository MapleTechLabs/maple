-- metadata
ALTER TABLE "cloud_security_service_states" ADD COLUMN IF NOT EXISTS "pushed_at" timestamp with time zone;
