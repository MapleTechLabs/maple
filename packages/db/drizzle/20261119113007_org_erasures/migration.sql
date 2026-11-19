-- metadata
CREATE TABLE IF NOT EXISTS "org_erasures" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"attempts" integer NOT NULL DEFAULT 0,
	"last_error" text,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_erasures_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "org_erasures_due_idx" ON "org_erasures" USING btree ("next_attempt_at");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "org_erasures_target_idx" ON "org_erasures" USING btree ("org_id", "kind", "target");
