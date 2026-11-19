-- metadata
CREATE TABLE IF NOT EXISTS "feature_requests" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"area" text NOT NULL,
	"subject" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feature_requests_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "feature_requests_area_created_idx" ON "feature_requests" USING btree ("area", "created_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "feature_requests_org_idx" ON "feature_requests" USING btree ("org_id");
