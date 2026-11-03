-- Keep only the newest live credential per (org, installation) before the unique index.
UPDATE "device_credentials" AS d SET "revoked_at" = now()
WHERE d."revoked_at" IS NULL AND EXISTS (
	SELECT 1 FROM "device_credentials" AS n
	WHERE n."org_id" = d."org_id" AND n."installation_id" = d."installation_id"
		AND n."revoked_at" IS NULL AND (n."created_at", n."id") > (d."created_at", d."id")
);
--> statement-breakpoint
-- metadata
DROP INDEX IF EXISTS "device_credentials_org_installation_idx";
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "device_credentials_live_installation_unique" ON "device_credentials" USING btree ("org_id", "installation_id") WHERE "revoked_at" IS NULL;
