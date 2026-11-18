-- metadata
DROP INDEX IF EXISTS "status_pages_slug_unq";
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_pages_org_slug_unq" ON "status_pages" USING btree ("org_id", "slug");
--> statement-breakpoint
-- Republish every page: the snapshot gains its org key and the edge route moves to `/s/<org key>/<slug>`.
UPDATE "status_pages" SET "revision" = "revision" + 1;
