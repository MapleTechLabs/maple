-- metadata
CREATE TABLE IF NOT EXISTS "self_hosted_login_attempts" (
	"key" text NOT NULL,
	"failures" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "self_hosted_login_attempts_pkey" PRIMARY KEY ("key")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "self_hosted_login_attempts_updated_idx" ON "self_hosted_login_attempts" USING btree ("updated_at");
