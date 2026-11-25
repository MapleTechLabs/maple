-- metadata
CREATE TABLE IF NOT EXISTS "storage_billing_runs" (
	"org_id" text NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"gb_months" double precision NOT NULL,
	"billed_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "storage_billing_runs_pkey" PRIMARY KEY ("org_id", "day")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "storage_billing_runs_day_idx" ON "storage_billing_runs" USING btree ("day");
