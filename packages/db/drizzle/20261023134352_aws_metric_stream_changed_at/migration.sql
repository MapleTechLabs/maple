-- metadata
ALTER TABLE "aws_connections" ADD COLUMN IF NOT EXISTS "metric_stream_changed_at" timestamp with time zone;
