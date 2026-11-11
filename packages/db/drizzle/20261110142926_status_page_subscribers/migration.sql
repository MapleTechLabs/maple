-- metadata
CREATE TABLE IF NOT EXISTS "status_page_subscribers" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"page_id" text NOT NULL,
	"email" text NOT NULL,
	"component_ids" jsonb,
	"confirmed_at" timestamp with time zone,
	"confirm_token_sha256" text,
	"confirm_expires_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_subscribers_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "status_page_update_notifications" (
	"update_id" text NOT NULL,
	"org_id" text NOT NULL,
	"page_id" text NOT NULL,
	"last_subscriber_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_page_update_notifications_pkey" PRIMARY KEY ("update_id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_page_subscribers_confirm_token_unq" ON "status_page_subscribers" USING btree ("confirm_token_sha256");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_page_subscribers_page_email_unq" ON "status_page_subscribers" USING btree ("page_id", "email");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "status_page_update_notifications_pending_idx" ON "status_page_update_notifications" USING btree ("created_at") WHERE completed_at IS NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "status_pages" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "status_page_update_notifications" ADD CONSTRAINT "status_page_update_notifications_TAITGL8oaHOK_fk" FOREIGN KEY ("update_id") REFERENCES "status_page_incident_updates" ("id") ON DELETE CASCADE;
