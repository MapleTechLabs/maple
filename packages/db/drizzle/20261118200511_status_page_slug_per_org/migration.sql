-- metadata
DROP INDEX IF EXISTS "status_pages_slug_unq";
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "legacy_slug_route" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_pages_org_slug_unq" ON "status_pages" USING btree ("org_id", "slug");
--> statement-breakpoint
-- Every page so far was published at the bare `/s/<slug>`: keep its slug reserved in every org, and
-- republish it so the snapshot gains its org key and the edge route moves to `/s/<org key>/<slug>`.
UPDATE "status_pages" SET "legacy_slug_route" = true, "revision" = "revision" + 1;
