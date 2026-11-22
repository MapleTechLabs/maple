-- metadata
CREATE TABLE IF NOT EXISTS "morph_spend_readings" (
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"month" text NOT NULL,
	"day" text NOT NULL,
	"member_id" text NOT NULL,
	"member_label" text NOT NULL,
	"opening_micros" bigint NOT NULL,
	"closing_micros" bigint NOT NULL,
	"first_read_at" timestamp with time zone NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "morph_spend_readings_pkey" PRIMARY KEY ("connection_id", "month", "member_id", "day")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "morph_spend_readings_org_idx" ON "morph_spend_readings" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "morph_spend_readings" ADD CONSTRAINT "morph_spend_readings_connection_id_cost_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "cost_connections" ("id") ON DELETE CASCADE;
