-- metadata
CREATE TABLE IF NOT EXISTS "org_billing_links" (
	"org_id" text NOT NULL,
	"billing_org_id" text NOT NULL,
	"linked_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_billing_links_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "org_billing_links_billing_org_idx" ON "org_billing_links" USING btree ("billing_org_id");
