-- ElectricSQL sync: converge `electric_publication_default` on the synced table set.
--
-- 0009 created the publication inside a DO block whose handlers swallowed every
-- failure. On the fresh EU database the publication already existed (empty, created
-- before the first migration ran), so CREATE PUBLICATION raised duplicate_object and
-- the handler rolled back the whole block, REPLICA IDENTITY FULL included. Later
-- migrations ADDed their tables to the existing publication, so dashboards,
-- alert_rules, alert_rule_states and alert_incidents were the only ones missing.
--
-- This migration is the state those guarded migrations were meant to produce, and it
-- is not guarded: PGlite runs CREATE/ALTER PUBLICATION and pg_publication_tables, so
-- a failure here is real and aborts the deploy. Every step checks the catalog first,
-- which makes it a no-op on a database that is already correct (the US prd).
--
-- `synced` is SYNCED_TABLES (packages/db/src/migrations.test.ts) as of this migration;
-- a table synced later gets its own migration, not an edit here.
DO $$
DECLARE
	synced text[] := ARRAY[
		'dashboards',
		'alert_rules',
		'alert_rule_states',
		'alert_incidents',
		'alert_destinations',
		'api_keys',
		'investigations'
	];
	synced_table text;
	stale_schema text;
	stale_table text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_default') THEN
		CREATE PUBLICATION electric_publication_default;
	END IF;

	FOREACH synced_table IN ARRAY synced LOOP
		-- Electric refuses to serve a shape over a table that is not FULL.
		IF (SELECT relreplident FROM pg_class WHERE oid = format('public.%I', synced_table)::regclass) <> 'f' THEN
			EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', synced_table);
		END IF;

		IF NOT EXISTS (
			SELECT 1
			FROM pg_publication_tables
			WHERE pubname = 'electric_publication_default'
				AND schemaname = 'public'
				AND tablename = synced_table
		) THEN
			EXECUTE format('ALTER PUBLICATION electric_publication_default ADD TABLE public.%I', synced_table);
		END IF;
	END LOOP;

	-- Anything else in the publication has no shape and only costs replication. FULL is
	-- table-wide, so it stays while another publication still carries the table.
	FOR stale_schema, stale_table IN
		SELECT schemaname, tablename
		FROM pg_publication_tables
		WHERE pubname = 'electric_publication_default'
			AND NOT (schemaname = 'public' AND tablename = ANY (synced))
	LOOP
		EXECUTE format('ALTER PUBLICATION electric_publication_default DROP TABLE %I.%I', stale_schema, stale_table);
		IF NOT EXISTS (
			SELECT 1
			FROM pg_publication_tables
			WHERE schemaname = stale_schema
				AND tablename = stale_table
		) THEN
			EXECUTE format('ALTER TABLE %I.%I REPLICA IDENTITY DEFAULT', stale_schema, stale_table);
		END IF;
	END LOOP;
END $$;
