-- metadata
ALTER TABLE "cloudflare_logpush_connectors" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "oauth_connections" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_connections" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "railway_connections" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "scrape_targets" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
UPDATE "sources" SET "kind" = CASE
	WHEN "is_default" THEN 'default'
	WHEN "key_hash" IS NOT NULL THEN 'token'
	ELSE 'integration'
END
WHERE "kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "kind" SET NOT NULL;
--> statement-breakpoint
-- Code deployed before this migration inserts sources without `kind`; fill it in until the
-- contract migration drops `is_default` (and this trigger) once nothing writes that way.
CREATE OR REPLACE FUNCTION "sources_fill_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."kind" IS NULL THEN
		NEW."kind" := CASE
			WHEN NEW."is_default" THEN 'default'
			WHEN NEW."key_hash" IS NOT NULL THEN 'token'
			ELSE 'integration'
		END;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "sources_fill_kind" BEFORE INSERT ON "sources" FOR EACH ROW EXECUTE FUNCTION "sources_fill_kind"();
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "last_poll_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "last_poll_ok_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "last_poll_error" text;
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "disconnected_at" timestamp with time zone;
--> statement-breakpoint
-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "poll_resources" jsonb;
--> statement-breakpoint
-- metadata
ALTER TABLE "vcs_installations" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "cloudflare_logpush_connectors_source_idx" ON "cloudflare_logpush_connectors" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "gcp_connectors_source_idx" ON "gcp_connectors" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "oauth_connections_source_idx" ON "oauth_connections" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "planetscale_connections_source_idx" ON "planetscale_connections" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "railway_connections_source_idx" ON "railway_connections" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "scrape_targets_source_idx" ON "scrape_targets" USING btree ("source_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "vcs_installations_source_idx" ON "vcs_installations" USING btree ("source_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "cloudflare_logpush_connectors" ADD CONSTRAINT "cloudflare_logpush_connectors_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE SET NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "gcp_connectors" ADD CONSTRAINT "gcp_connectors_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "planetscale_connections" ADD CONSTRAINT "planetscale_connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "railway_connections" ADD CONSTRAINT "railway_connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "scrape_targets" ADD CONSTRAINT "scrape_targets_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- metadata
ALTER TABLE "vcs_installations" ADD CONSTRAINT "vcs_installations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Every integration row gets the source it sends as. Missing integration sources are created
-- first (the partial unique index on (org_id, platform, integration_id) dedupes), then linked.
INSERT INTO "sources" ("id", "org_id", "name", "platform", "kind", "is_default", "integration_id", "created_at", "updated_at")
SELECT gen_random_uuid()::text, i.org_id, i.name, i.platform, 'integration', false, i.integration_id, now(), now()
FROM (
	SELECT "org_id", 'prometheus' AS platform, "id" AS integration_id, "name"
	FROM "scrape_targets" WHERE "managed_by" IS NULL
	UNION ALL
	SELECT "org_id", 'gcp', "id", 'Google Cloud ' || "scope_id" FROM "gcp_connectors"
	UNION ALL
	SELECT "org_id", 'railway', "id", COALESCE("workspace_names", 'Railway') FROM "railway_connections"
	UNION ALL
	SELECT "org_id", 'planetscale', "id", 'PlanetScale ' || "ps_organization" FROM "planetscale_connections"
	UNION ALL
	SELECT "org_id", 'cloudflare', "id", COALESCE("external_account_name", 'Cloudflare')
	FROM "oauth_connections" WHERE "provider" = 'cloudflare'
	UNION ALL
	SELECT "org_id", 'github', "id", 'GitHub ' || "account_login" FROM "vcs_installations" WHERE "provider" = 'github'
) i
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "scrape_targets" t SET "source_id" = s."id" FROM "sources" s
WHERE t."source_id" IS NULL AND t."managed_by" IS NULL
	AND s."org_id" = t."org_id" AND s."platform" = 'prometheus' AND s."integration_id" = t."id";
--> statement-breakpoint
-- PlanetScale-managed targets send as their connection's source.
UPDATE "scrape_targets" t SET "source_id" = s."id" FROM "sources" s
WHERE t."source_id" IS NULL AND t."managed_by" LIKE 'planetscale:%'
	AND s."org_id" = t."org_id" AND s."platform" = 'planetscale'
	AND s."integration_id" = substring(t."managed_by" FROM length('planetscale:') + 1);
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
UPDATE "oauth_connections" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND c."provider" = 'cloudflare'
	AND s."org_id" = c."org_id" AND s."platform" = 'cloudflare' AND s."integration_id" = c."id";
--> statement-breakpoint
UPDATE "vcs_installations" c SET "source_id" = s."id" FROM "sources" s
WHERE c."source_id" IS NULL AND c."provider" = 'github'
	AND s."org_id" = c."org_id" AND s."platform" = 'github' AND s."integration_id" = c."id";
--> statement-breakpoint
-- Logpush jobs send as the org's Cloudflare connection (one per org); without one they stay unlinked.
UPDATE "cloudflare_logpush_connectors" l SET "source_id" = c."source_id" FROM "oauth_connections" c
WHERE l."source_id" IS NULL AND c."org_id" = l."org_id" AND c."provider" = 'cloudflare' AND c."source_id" IS NOT NULL;
--> statement-breakpoint
-- Integration sources nothing owns any more (their integration row is gone).
DELETE FROM "sources" s
WHERE s."kind" = 'integration'
	AND NOT EXISTS (SELECT 1 FROM "scrape_targets" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "gcp_connectors" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "railway_connections" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "planetscale_connections" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "oauth_connections" x WHERE x."source_id" = s."id")
	AND NOT EXISTS (SELECT 1 FROM "vcs_installations" x WHERE x."source_id" = s."id");
