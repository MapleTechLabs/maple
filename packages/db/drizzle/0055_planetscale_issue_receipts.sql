CREATE TABLE "planetscale_issue_receipts" (
	"org_id" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "planetscale_issue_receipts_org_id_event_id_pk" PRIMARY KEY("org_id","event_id")
);
--> statement-breakpoint
CREATE INDEX "planetscale_issue_receipts_processed_at_idx" ON "planetscale_issue_receipts" USING btree ("processed_at");