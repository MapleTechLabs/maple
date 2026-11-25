import { String as Str } from "effect"
import {
	AwsConnections,
	CookielessSalts,
	CookielessVisits,
	CloudflareLogpushConnectors,
	GcpConnectors,
	OrgBillingLinks,
	OrgClickHouseSettings,
	OrgIngestAttributeMappings,
	OrgIngestKeys,
	OrgIngestRuleSettings,
	OrgIngestRuleStats,
	OrgIngestRules,
	OrgIngestSamplingPolicies,
	OrgRetentionPolicies,
	Sources,
	VercelProjects,
} from "./tables"

/**
 * Postgres built-in roles a login inherits instead of `postgres`, which owns every table. Both
 * cover tables created by later migrations, so no per-table grant or default privilege is needed.
 */
export const DB_ACCESS_ROLES = {
	/** SELECT on every table, view and sequence. */
	read: ["pg_read_all_data"],
	/** Plus INSERT, UPDATE, DELETE. No DDL, TRUNCATE, ownership or role management. */
	readWrite: ["pg_read_all_data", "pg_write_all_data"],
} as const

export type DbAccess = keyof typeof DB_ACCESS_ROLES

/**
 * The ingest gateway's group role, created by the `ingest_gateway_role` migration. Its login
 * inherits no built-in role and is granted this one by the deploy (`IngestRoleMembership`).
 */
export const INGEST_GATEWAY_ROLE = "maple_ingest"

export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE"

/**
 * Exactly what the gateway's Postgres store (`PostgresKeyStore`, apps/ingest/src/main.rs) runs.
 * A statement on a table or privilege not listed here is refused once the switch is on.
 */
export const INGEST_GATEWAY_GRANTS: ReadonlyArray<{
	readonly table: { readonly name: string }
	readonly privileges: ReadonlyArray<TablePrivilege>
}> = [
	{ table: OrgIngestKeys, privileges: ["SELECT"] },
	{ table: OrgClickHouseSettings, privileges: ["SELECT"] },
	{ table: OrgIngestSamplingPolicies, privileges: ["SELECT"] },
	{ table: OrgIngestAttributeMappings, privileges: ["SELECT"] },
	{ table: VercelProjects, privileges: ["SELECT"] },
	{ table: OrgIngestRules, privileges: ["SELECT"] },
	{ table: OrgIngestRuleSettings, privileges: ["SELECT"] },
	{ table: OrgBillingLinks, privileges: ["SELECT"] },
	// Read with each key and connector, to stamp rows with how long their source keeps them.
	{ table: OrgRetentionPolicies, privileges: ["SELECT"] },
	// Last used / last rejected on sources, and each connector's health columns.
	{ table: Sources, privileges: ["SELECT", "UPDATE"] },
	{ table: CloudflareLogpushConnectors, privileges: ["SELECT", "UPDATE"] },
	{ table: GcpConnectors, privileges: ["SELECT", "UPDATE"] },
	{ table: AwsConnections, privileges: ["SELECT", "UPDATE"] },
	// The hourly upsert (`ON CONFLICT ... DO UPDATE` reads the row it adds to). No serial column.
	{ table: OrgIngestRuleStats, privileges: ["SELECT", "INSERT", "UPDATE"] },
	// Cookieless visitors: the gateway mints the day's salt, claims visits, and deletes both once stale.
	{ table: CookielessSalts, privileges: ["SELECT", "INSERT", "DELETE"] },
	{ table: CookielessVisits, privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
]

const sqlLiteral = (value: string) => `'${Str.replaceAll("'", "''")(value)}'`

/**
 * Run by the deploy as a short-lived admin login, after `login` exists and before the gateway
 * uses it. `login` is the connection username; a hosted branch may suffix it (`<role>.<branch>`),
 * so the role is looked up in the catalog. Membership needs `postgres`'s ADMIN OPTION on the
 * group role, which a member does not inherit, hence the SET ROLE. Fails when the login still
 * reaches every table.
 */
export const ingestRoleMembershipSql = (login: string): string => `DO $$
DECLARE
	target text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INGEST_GATEWAY_ROLE}') THEN
		RAISE EXCEPTION 'role ${INGEST_GATEWAY_ROLE} is missing: the ingest_gateway_role migration has not run';
	END IF;
	SELECT rolname INTO target FROM pg_roles
	WHERE rolname IN (${sqlLiteral(login)}, split_part(${sqlLiteral(login)}, '.', 1))
	ORDER BY rolname = ${sqlLiteral(login)} DESC
	LIMIT 1;
	IF target IS NULL THEN
		RAISE EXCEPTION 'no role for login %', ${sqlLiteral(login)};
	END IF;
	IF pg_has_role(target, 'pg_read_all_data', 'MEMBER') OR pg_has_role(target, 'pg_write_all_data', 'MEMBER') THEN
		RAISE EXCEPTION 'login % still inherits pg_read_all_data or pg_write_all_data', target;
	END IF;
	IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
		AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
		SET ROLE postgres;
	END IF;
	EXECUTE format('GRANT %I TO %I', '${INGEST_GATEWAY_ROLE}', target);
	RESET ROLE;
END $$`
