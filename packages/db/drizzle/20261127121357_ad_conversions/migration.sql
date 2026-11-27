-- metadata
CREATE TABLE IF NOT EXISTS "ad_conversions" (
	"user_id" text NOT NULL,
	"conversion" text NOT NULL,
	"click_type" text NOT NULL,
	"click_id" text NOT NULL,
	"click_at" timestamp with time zone NOT NULL,
	"converted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ad_conversions_pkey" PRIMARY KEY ("user_id", "conversion")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "ad_conversions_click_at_idx" ON "ad_conversions" USING btree ("click_at");
