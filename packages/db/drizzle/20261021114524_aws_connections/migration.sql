-- metadata
CREATE TABLE IF NOT EXISTS "aws_connections" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"source_id" text NOT NULL,
	"account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"modules" jsonb NOT NULL,
	"granted_modules" jsonb,
	"template_version" integer,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"check_lease_until" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "aws_connections_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "aws_connections_org_account_idx" ON "aws_connections" USING btree ("org_id", "account_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "aws_connections_source_idx" ON "aws_connections" USING btree ("source_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "aws_connections" ADD CONSTRAINT "aws_connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
