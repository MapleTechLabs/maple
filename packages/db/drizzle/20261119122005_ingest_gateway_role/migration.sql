-- The ingest gateway's group role: exactly the tables and privileges its Postgres store uses
-- (`INGEST_GATEWAY_GRANTS`, packages/db/src/roles.ts). The deploy grants it to the gateway's
-- login (`IngestRoleMembership`) once `MAPLE_INGEST_DB_SCOPED_ROLE` is on; until then nothing
-- uses it. A table the gateway starts using gets its own migration, not an edit here.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maple_ingest') THEN
		-- CREATEROLE is not inherited through membership: a login that is only a member of
		-- `postgres` (the hosted database's migration login) creates the role as `postgres`.
		IF NOT (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user)
			AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
			SET ROLE postgres;
		END IF;
		CREATE ROLE maple_ingest NOLOGIN;
		RESET ROLE;
	END IF;
END $$;
--> statement-breakpoint
GRANT SELECT ON TABLE
	org_ingest_keys,
	org_clickhouse_settings,
	org_ingest_sampling_policies,
	org_ingest_attribute_mappings,
	vercel_projects,
	org_ingest_rules,
	org_ingest_rule_settings,
	org_billing_links
TO maple_ingest;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE
	sources,
	cloudflare_logpush_connectors,
	gcp_connectors,
	aws_connections
TO maple_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE org_ingest_rule_stats TO maple_ingest;
