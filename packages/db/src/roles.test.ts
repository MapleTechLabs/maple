import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { PGlite } from "@electric-sql/pglite"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import { Effect, Layer, Array as Arr, Order } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { migrateBundled } from "./migrate"
import {
	DB_ACCESS_ROLES,
	type DbAccess,
	INGEST_GATEWAY_GRANTS,
	INGEST_GATEWAY_ROLE,
	ingestRoleMembershipSql,
} from "./roles"

// The real schema, migrated as the owner; each check runs as a login holding only the given roles.
const pg = new PGlite()

beforeAll(async () => {
	await Effect.runPromise(
		migrateBundled.pipe(
			Effect.provide(
				Migrate.layerSqlClient().pipe(Layer.provide(PgliteClient.layer({ liveClient: pg }))),
			),
		),
	)
	await pg.exec(`CREATE ROLE login_read NOLOGIN IN ROLE ${Arr.join(DB_ACCESS_ROLES.read, ", ")}`)
	await pg.exec(`CREATE ROLE login_readwrite NOLOGIN IN ROLE ${Arr.join(DB_ACCESS_ROLES.readWrite, ", ")}`)
	// The previous grant, kept as the control the checks below must tell apart.
	await pg.exec("CREATE ROLE login_owner NOLOGIN IN ROLE postgres")
	// The gateway's login: no built-in role, then the deploy's membership grant.
	await pg.exec("CREATE ROLE login_ingest NOLOGIN")
	await pg.exec(ingestRoleMembershipSql("login_ingest"))
}, 120_000)

afterAll(() => pg.close())

const loginFor = { read: "login_read", readWrite: "login_readwrite" } satisfies Record<DbAccess, string>

/**
 * Runs one statement as `role` and rolls back. "denied" is a privilege refusal; "ok" includes
 * an error raised after the privilege check passed (a dependent object blocking a DROP).
 */
const runAs = async (role: string, statement: string): Promise<"ok" | "denied"> => {
	await pg.exec(`BEGIN; SET LOCAL ROLE ${role}`)
	const error = await pg.exec(statement).then(
		() => undefined,
		(cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
	)
	await pg.exec("ROLLBACK")
	if (error === undefined || /depend on it/.test(error)) return "ok"
	if (/permission denied|must be owner/.test(error)) return "denied"
	return expect.unreachable(error)
}

const reads = ["SELECT count(*) FROM sources", "SELECT count(*) FROM org_ingest_keys"]
const writes = [
	"INSERT INTO sources SELECT * FROM sources WHERE false",
	"UPDATE sources SET last_used_at = now() WHERE id = 'missing'",
	"DELETE FROM api_keys WHERE id = 'missing'",
	"SELECT nextval('scrape_target_checks_id_seq')",
]
const ddl = [
	"CREATE TABLE public.injected (id int)",
	"DROP TABLE sources",
	"ALTER TABLE sources ADD COLUMN injected int",
	"TRUNCATE sources",
	"CREATE ROLE injected",
]

describe("runtime database roles", () => {
	it.each(reads)("read-only login can run %s", async (statement) => {
		expect(await runAs(loginFor.read, statement)).toBe("ok")
	})

	it.each(writes)("read-only login is refused %s", async (statement) => {
		expect(await runAs(loginFor.read, statement)).toBe("denied")
	})

	it.each([...reads, ...writes])("read-write login can run %s", async (statement) => {
		expect(await runAs(loginFor.readWrite, statement)).toBe("ok")
	})

	it.each(ddl)("read-write login is refused %s", async (statement) => {
		expect(await runAs(loginFor.readWrite, statement)).toBe("denied")
	})

	it("covers a table a later migration creates, with no extra grant", async () => {
		await pg.exec("CREATE TABLE public.later_migration (id int)")
		expect(await runAs(loginFor.readWrite, "INSERT INTO later_migration VALUES (1)")).toBe("ok")
		expect(await runAs(loginFor.read, "SELECT * FROM later_migration")).toBe("ok")
	})

	it.each(ddl.slice(0, 3))("the previous postgres-inheriting login could run %s", async (statement) => {
		expect(await runAs("login_owner", statement)).toBe("ok")
	})
})

// The statement shapes PostgresKeyStore (apps/ingest/src/main.rs) runs, one per query it issues.
const gatewayStatements = [
	"SELECT k.org_id, s.sync_status, ds.id FROM org_ingest_keys k LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id LEFT JOIN sources ds ON ds.org_id = k.org_id AND ds.kind = 'default' WHERE k.private_key_hash = 'x' LIMIT 1",
	"SELECT k.id, k.allowed_signals, s.sync_status FROM sources k LEFT JOIN org_clickhouse_settings s ON s.org_id = k.org_id WHERE k.key_hash = 'x' LIMIT 1",
	"SELECT c.org_id, src.id FROM cloudflare_logpush_connectors c LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id LEFT JOIN sources src ON src.id = c.source_id AND src.org_id = c.org_id WHERE c.id = 'x' LIMIT 1",
	"SELECT c.org_id, c.project_id FROM gcp_connectors c LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id WHERE c.id = 'x' LIMIT 1",
	"SELECT c.org_id FROM aws_connections c LEFT JOIN org_clickhouse_settings s ON s.org_id = c.org_id WHERE c.id = 'x' LIMIT 1",
	"SELECT trace_sample_ratio FROM org_ingest_sampling_policies WHERE org_id = 'x' LIMIT 1",
	"SELECT source_key, target_key FROM org_ingest_attribute_mappings WHERE org_id = 'x' AND enabled = true",
	"SELECT project_id, name FROM vercel_projects WHERE org_id = 'x'",
	"SELECT r.id, s.hash_salt FROM org_ingest_rules r LEFT JOIN org_ingest_rule_settings s ON s.org_id = r.org_id WHERE r.org_id = 'x'",
	"SELECT ch_url, ch_password_ciphertext FROM org_clickhouse_settings WHERE org_id = 'x' LIMIT 1",
	"SELECT billing_org_id FROM org_billing_links WHERE org_id = 'x'",
	"UPDATE sources SET last_used_at = now() WHERE id = 'x'",
	"UPDATE sources SET last_rejected_at = now(), last_rejection = 'x' WHERE id = 'x'",
	"UPDATE cloudflare_logpush_connectors SET last_received_at = now(), last_error = NULL, updated_at = now() WHERE id = 'x'",
	"UPDATE gcp_connectors SET last_error = 'x', updated_at = now() WHERE id = 'x'",
	"UPDATE aws_connections SET stream_last_error = 'x' WHERE id = 'x'",
	"INSERT INTO org_ingest_rule_stats (org_id, rule_id, bucket, signal, matched, dropped, dropped_bytes, redacted_values) VALUES ('o', 'r', now(), 'traces', 1, 0, 0, 0) ON CONFLICT (org_id, rule_id, bucket, signal) DO UPDATE SET matched = org_ingest_rule_stats.matched + EXCLUDED.matched",
]

const outsideTheGateway = [
	"SELECT count(*) FROM api_keys",
	"UPDATE org_ingest_keys SET private_key_hash = 'x' WHERE org_id = 'x'",
	"DELETE FROM sources WHERE id = 'x'",
	"INSERT INTO sources SELECT * FROM sources WHERE false",
	"TRUNCATE org_ingest_rule_stats",
	"CREATE TABLE public.injected (id int)",
]

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]

describe("ingest gateway role", () => {
	it("holds exactly the grants the gateway's tables list, on every table in the schema", async () => {
		const result = await pg.query<{ grant: string }>(
			`SELECT t.tablename || ' ' || p.privilege AS grant
			 FROM pg_tables t CROSS JOIN unnest($1::text[]) AS p(privilege)
			 WHERE t.schemaname = 'public'
			   AND has_table_privilege($2, format('public.%I', t.tablename), p.privilege)
			 ORDER BY 1`,
			[PRIVILEGES, INGEST_GATEWAY_ROLE],
		)
		const expected = Arr.sort(
			Arr.flatMap(INGEST_GATEWAY_GRANTS, ({ table, privileges }) =>
				Arr.map(privileges, (privilege) => `${table.name} ${privilege}`),
			),
			Order.String,
		)
		expect(Arr.map(result.rows, (row) => row.grant)).toEqual(expected)
	})

	it.each(gatewayStatements)("a login granted the role can run %s", async (statement) => {
		expect(await runAs("login_ingest", statement)).toBe("ok")
	})

	it.each(outsideTheGateway)("a login granted the role is refused %s", async (statement) => {
		expect(await runAs("login_ingest", statement)).toBe("denied")
	})

	it("finds the login's role when the connection username carries a branch suffix", async () => {
		await pg.exec("CREATE ROLE login_suffixed NOLOGIN")
		await pg.exec(ingestRoleMembershipSql("login_suffixed.branch123"))
		expect(await runAs("login_suffixed", "SELECT count(*) FROM org_ingest_keys")).toBe("ok")
	})

	it("grants as `postgres` when the admin login is only a member of it, as on the hosted branch", async () => {
		await pg.exec("CREATE ROLE admin_member NOLOGIN IN ROLE postgres; CREATE ROLE login_hosted NOLOGIN")
		await pg.exec("BEGIN; SET LOCAL ROLE admin_member")
		await pg.exec(ingestRoleMembershipSql("login_hosted"))
		await pg.exec("COMMIT")
		expect(await runAs("login_hosted", "UPDATE sources SET last_used_at = now() WHERE id = 'x'")).toBe(
			"ok",
		)
	})

	it("refuses to grant the role to a login that still reads every table", async () => {
		await expect(pg.exec(ingestRoleMembershipSql(loginFor.readWrite))).rejects.toThrow(
			"still inherits pg_read_all_data or pg_write_all_data",
		)
	})
})
