-- metadata
DROP INDEX IF EXISTS "status_pages_slug_unq";
--> statement-breakpoint
-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "legacy_slug_route" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "status_pages_org_slug_unq" ON "status_pages" USING btree ("org_id", "slug");
--> statement-breakpoint
-- A page published so far was served at the bare `/s/<slug>`: keep its slug reserved in every org.
UPDATE "status_pages" SET "legacy_slug_route" = true WHERE "published_at" IS NOT NULL;
--> statement-breakpoint
-- Republish every page so the snapshot gains its org key and the edge route moves to `/s/<org key>/<slug>`.
UPDATE "status_pages" SET "revision" = "revision" + 1;
