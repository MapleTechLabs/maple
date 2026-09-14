CREATE TABLE "google_analytics_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"property_id" text NOT NULL,
	"dataset" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"emitted_json" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_analytics_state" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"property_id" text DEFAULT '' NOT NULL,
	"property_name" text,
	"account_name" text,
	"time_zone" text,
	"dataset" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"watermark_at" timestamp with time zone,
	"backfill_at" timestamp with time zone,
	"frozen_through_at" timestamp with time zone,
	"discovered_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ga_ledger_org_property_dataset_bucket_idx" ON "google_analytics_ledger" USING btree ("org_id","property_id","dataset","bucket_at");--> statement-breakpoint
CREATE INDEX "ga_ledger_org_bucket_idx" ON "google_analytics_ledger" USING btree ("org_id","bucket_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ga_analytics_state_org_property_dataset_idx" ON "google_analytics_state" USING btree ("org_id","property_id","dataset");--> statement-breakpoint
CREATE INDEX "ga_analytics_state_org_idx" ON "google_analytics_state" USING btree ("org_id");