-- metadata
CREATE TABLE IF NOT EXISTS "cookieless_salts" (
	"day" text NOT NULL,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "cookieless_salts_pkey" PRIMARY KEY ("day")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "cookieless_visits" (
	"org_id" text NOT NULL,
	"visitor_id" text NOT NULL,
	"visit_token" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cookieless_visits_pkey" PRIMARY KEY ("org_id", "visitor_id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "cookieless_visits_last_seen_idx" ON "cookieless_visits" USING btree ("last_seen_at");
--> statement-breakpoint
-- The ingest gateway mints, reads and deletes these itself (`INGEST_GATEWAY_GRANTS`, roles.ts).
GRANT SELECT, INSERT, DELETE ON TABLE cookieless_salts TO maple_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cookieless_visits TO maple_ingest;
