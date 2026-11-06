-- Objects no table definition has and nothing reads or writes: left behind by
-- schema changes without a migration, or created outside the migrations.
DROP TABLE IF EXISTS "ai_triage_runs";
--> statement-breakpoint
ALTER TABLE "ai_triage_settings" DROP COLUMN IF EXISTS "fanout_enabled";
--> statement-breakpoint
ALTER TABLE "ai_triage_settings" DROP COLUMN IF EXISTS "investigation_mode";
--> statement-breakpoint
DROP INDEX IF EXISTS "alert_destinations_org_id_replident_idx";
