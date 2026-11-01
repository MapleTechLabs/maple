-- metadata
ALTER TABLE "cancellation_reviews" ADD COLUMN IF NOT EXISTS "model_read" jsonb;
