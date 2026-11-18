-- metadata
CREATE TABLE IF NOT EXISTS "gcp_cost_exports" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"table_ref" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gcp_cost_exports_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "gcp_cost_exports_connector_idx" ON "gcp_cost_exports" USING btree ("connector_id");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "gcp_cost_exports_org_account_idx" ON "gcp_cost_exports" USING btree ("org_id", "billing_account_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_cost_exports" ADD CONSTRAINT "gcp_cost_exports_connector_id_gcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "gcp_connectors" ("id") ON DELETE CASCADE;
