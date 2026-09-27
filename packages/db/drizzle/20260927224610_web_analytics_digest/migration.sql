ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_last_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_last_attempted_at" timestamp with time zone;--> statement-breakpoint
-- Existing rows inherit the ops digest's state rather than the new column's
-- default: a member who opted out of weekly email stays out of this one too,
-- and a row the Clerk sweep disabled (a departed member) stays off.
UPDATE "digest_subscriptions" SET "web_analytics_enabled" = false, "web_analytics_opted_out_at" = "opted_out_at" WHERE "opted_out_at" IS NOT NULL;--> statement-breakpoint
UPDATE "digest_subscriptions" SET "web_analytics_enabled" = false WHERE "enabled" = false AND "opted_out_at" IS NULL;
