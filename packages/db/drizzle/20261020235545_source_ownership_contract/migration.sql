-- Rows written by code deployed before 20261020231653_source_ownership have no source yet, and
-- sources it left behind have no owner. Settle both before `source_id` becomes NOT NULL.
-- A target managed by a PlanetScale connection that is gone becomes the user's own target.
UPDATE "scrape_targets" t SET "managed_by" = NULL
WHERE t."source_id" IS NULL AND t."managed_by" LIKE 'planetscale:%'
	AND NOT EXISTS (
		SELECT 1 FROM "planetscale_connections" c
		WHERE c."org_id" = t."org_id" AND c."id" = substring(t."managed_by" FROM length('planetscale:') + 1)
	);
--> statement-breakpoint
INSERT INTO "sources" ("id", "org_id", "name", "platform", "kind", "is_default", "integration_id", "created_at", "updated_at")
SELECT gen_random_uuid()::text, i.org_id, i.name, i.platform, 'integration', false, i.integration_id, now(), now()
FROM (
	SELECT "org_id", 'prometheus' AS platform, "id" AS integration_id, "name"
	FROM "scrape_targets" WHERE "managed_by" IS NULL AND "source_id" IS NULL
	UNION ALL
	SELECT "org_id", 'gcp', "id", 'Google Cloud ' || "scope_id" FROM "gcp_connectors" WHERE "source_id" IS NULL
	UNION ALL
	SELECT "org_id", 'railway', "id", COALESCE("workspace_names", 'Railway') FROM "railway_connections" WHERE "source_id" IS NULL
	UNION ALL
	SELECT "org_id", 'planetscale', "id", 'PlanetScale ' || "ps_organization" FROM "planetscale_connections" WHERE "source_id" IS NULL
	UNION ALL
	SELECT "org_id", 'cloudflare', "id", COALESCE("external_account_name", 'Cloudflare')
	FROM "oauth_connections" WHERE "provider" = 'cloudflare' AND "source_id" IS NULL
	UNION ALL
	SELECT "org_id", 'github', "id", 'GitHub ' || "account_login" FROM "vcs_installations" WHERE "source_id" IS NULL
) i
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "scrape_targets" t SET "source_id" = s."id" FROM "sources" s
WHERE t."source_id" IS NULL AND t."managed_by" IS NULL
	AND s."org_id" = t."org_id" AND s."platform" = 'prometheus' AND s."integration_id" = t."id";
--> statement-breakpoint
UPDATE "gcp_connectors" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND s."org_id" = c."org_id" AND s."platform" = 'gcp' AND s."integration_id" = c."id";
--> statement-breakpoint
UPDATE "railway_connections" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND s."org_id" = c."org_id" AND s."platform" = 'railway' AND s."integration_id" = c."id";
--> statement-breakpoint
UPDATE "planetscale_connections" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND s."org_id" = c."org_id" AND s."platform" = 'planetscale' AND s."integration_id" = c."id";
--> statement-breakpoint
-- After the connections are linked: a target managed by one sends as its source.
UPDATE "scrape_targets" t SET "source_id" = c."source_id" FROM "planetscale_connections" c
WHERE t."source_id" IS NULL AND t."managed_by" LIKE 'planetscale:%'
	AND c."org_id" = t."org_id" AND c."id" = substring(t."managed_by" FROM length('planetscale:') + 1);
--> statement-breakpoint
UPDATE "oauth_connections" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND c."provider" = 'cloudflare'
	AND s."org_id" = c."org_id" AND s."platform" = 'cloudflare' AND s."integration_id" = c."id";
--> statement-breakpoint
UPDATE "vcs_installations" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND s."org_id" = c."org_id" AND s."platform" = 'github' AND s."integration_id" = c."id";
--> statement-breakpoint
UPDATE "cloudflare_logpush_connectors" l SET "source_id" = c."source_id" FROM "oauth_connections" c
WHERE l."source_id" IS NULL AND c."org_id" = l."org_id" AND c."provider" = 'cloudflare' AND c."source_id" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "sources" s
WHERE s."kind" = 'integration'
	AND NOT EXISTS (SELECT 1 FROM "scrape_targets" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "gcp_connectors" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "railway_connections" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "planetscale_connections" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "oauth_connections" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "vcs_installations" x WHERE x."source_id" = s."id");
--> statement-breakpoint
-- Every writer now sets `kind`.
DROP TRIGGER IF EXISTS "sources_fill_kind" ON "sources";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "sources_fill_kind"();
--> statement-breakpoint
-- metadata
DROP INDEX IF EXISTS "sources_org_default_unique";
--> statement-breakpoint
-- metadata
DROP INDEX IF EXISTS "sources_org_integration_unique";
--> statement-breakpoint
-- destructive
ALTER TABLE "sources" DROP COLUMN IF EXISTS "is_default";
--> statement-breakpoint
-- destructive
ALTER TABLE "sources" DROP COLUMN IF EXISTS "integration_id";
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_connections" ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "railway_connections" ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "scrape_targets" ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "vcs_installations" ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "sources_org_default_kind_unique" ON "sources" USING btree ("org_id") WHERE "kind" = 'default';
