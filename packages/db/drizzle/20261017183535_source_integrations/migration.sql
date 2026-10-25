-- metadata
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "integration_id" text;
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "sources_org_integration_unique" ON "sources" USING btree ("org_id", "platform", "integration_id") WHERE "integration_id" IS NOT NULL;
