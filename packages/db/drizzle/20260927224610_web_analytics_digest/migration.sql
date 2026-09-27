ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_last_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD COLUMN "web_analytics_last_attempted_at" timestamp with time zone;