-- metadata
CREATE TABLE IF NOT EXISTS "slos" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"service_name" text NOT NULL,
	"environments_json" jsonb NOT NULL,
	"sli_json" jsonb NOT NULL,
	"target_percent" double precision NOT NULL,
	"window_days" integer NOT NULL,
	"alert_rule_id" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slos_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "slos_org_idx" ON "slos" USING btree ("org_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "slos_org_name_unq" ON "slos" USING btree ("org_id", "name");
