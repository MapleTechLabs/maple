import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { PGlite } from "@electric-sql/pglite"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { migrateBundled } from "./migrate"
import { DB_ACCESS_ROLES, type DbAccess } from "./roles"

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
	await pg.exec(`CREATE ROLE login_read NOLOGIN IN ROLE ${DB_ACCESS_ROLES.read.join(", ")}`)
	await pg.exec(`CREATE ROLE login_readwrite NOLOGIN IN ROLE ${DB_ACCESS_ROLES.readWrite.join(", ")}`)
	// The previous grant, kept as the control the checks below must tell apart.
	await pg.exec("CREATE ROLE login_owner NOLOGIN IN ROLE postgres")
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
