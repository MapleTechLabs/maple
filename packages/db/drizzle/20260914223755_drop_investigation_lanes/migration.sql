DROP TABLE "investigation_lens_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "fanout_state";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "fanout_size";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "plan_json";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "planner_model";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "planner_elapsed_ms";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "validator_note";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "validator_elapsed_ms";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "fanout_deadline_at";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "workflow_instance_id";--> statement-breakpoint
ALTER TABLE "investigations" DROP COLUMN "fanout_attempt";--> statement-breakpoint
-- The lane table left the Electric publication with the table. Guarded like
-- 0037: the embedded PGlite test path supports neither ALTER PUBLICATION nor
-- the pg_publication_tables catalog.
DO $$
BEGIN
	ALTER PUBLICATION electric_publication_default DROP TABLE "investigation_lens_runs";
EXCEPTION
	WHEN OTHERS THEN
		RAISE NOTICE 'electric publication lane-table drop skipped: %', SQLERRM;
END $$;
