-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "events_key_salt" text;
