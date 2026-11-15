-- metadata
CREATE TABLE IF NOT EXISTS "saved_views" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"surface" text NOT NULL,
	"name" text NOT NULL,
	"state" jsonb NOT NULL,
	"visibility" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saved_views_org_id_id_pk" PRIMARY KEY ("org_id", "id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "saved_views_org_surface_idx" ON "saved_views" USING btree ("org_id", "surface", "visibility");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "saved_views_owner_surface_name_unq" ON "saved_views" USING btree ("org_id", "owner_user_id", "surface", "name");
