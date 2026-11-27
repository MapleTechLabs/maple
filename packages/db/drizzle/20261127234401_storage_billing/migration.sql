-- metadata
CREATE TABLE IF NOT EXISTS "ingest_storage_ledger" (
	"org_id" text NOT NULL,
	"signal" text NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"retention_days" integer NOT NULL,
	"bytes" bigint NOT NULL DEFAULT 0,
	CONSTRAINT "ingest_storage_ledger_pkey" PRIMARY KEY ("org_id", "signal", "day", "retention_days")
);
--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "ingest_storage_ledger_day_idx" ON "ingest_storage_ledger" USING btree ("day");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "storage_billing_runs_day_idx" ON "storage_billing_runs" USING btree ("day");
--> statement-breakpoint
-- The gateway adds each flush's bytes with an upsert (`INGEST_GATEWAY_GRANTS`, roles.ts).
GRANT SELECT, INSERT, UPDATE ON TABLE ingest_storage_ledger TO maple_ingest;
