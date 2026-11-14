-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "metrics_hold_until" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "metrics_polled_at" timestamp with time zone;
--> statement-breakpoint
-- metrics_lease_until used to be the never-cleared poll cursor: carry it into metrics_polled_at.
UPDATE "gcp_connectors" SET "metrics_polled_at" = LEAST("metrics_lease_until" - interval '4 minutes', now()) WHERE "metrics_lease_until" IS NOT NULL;
--> statement-breakpoint
-- A live ingest-refusal hold also lived in metrics_lease_until; move it so a deploy does not lift it.
UPDATE "gcp_connectors" SET "metrics_hold_until" = "metrics_lease_until", "metrics_lease_until" = NULL WHERE "metrics_lease_until" > now() + interval '4 minutes';
--> statement-breakpoint
UPDATE "gcp_connectors" SET "metrics_lease_until" = NULL WHERE "metrics_lease_until" <= now();
