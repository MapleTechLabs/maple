import { afterEach, describe, expect, it } from "@effect/vitest"
import { registerDriver, type QueryRequest, type DriverConnection } from "@maple/data-sources"
import {
	DataSourceConnectionError,
	DataSourceValidationError,
	type CatalogEntry,
	type ClerkDataSourceConfig,
	type ClickHouseDataSourceConfig,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import { OrgId, UserId } from "@maple/domain/primitives"
import { ExternalDataSources } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { DataSourceCallBudget, DataSourceDrivers } from "./DataSourceDrivers"
import { ExternalDataSourceService } from "./ExternalDataSourceService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_sources")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_admin")
const SECRET = "sk_test_supersecretvalue1234"

/** What the fake drivers answer, and what they saw. */
interface World {
	testFails: boolean
	sqlCatalog: SourceCatalog
	readonly seenSecrets: Array<string | null>
	readonly prepared: Array<{ readonly request: QueryRequest; readonly entries: ReadonlyArray<string> }>
	runs: number
}

const table = (name: string, fields: CatalogEntry["fields"]): CatalogEntry => ({ name, kind: "table", fields })

const makeWorld = (): World => ({
	testFails: false,
	sqlCatalog: {
		entries: [
			table("shop.payments", [
				{ name: "status", type: "string", sampleValues: ["paid", "failed"] },
				{ name: "email", type: "string", pii: true, sampleValues: ["ada@example.com"] },
			]),
			table("shop.orders", [{ name: "id", type: "string" }]),
		],
		examples: [{ title: "Failed payments", query: { _tag: "sql", sql: "SELECT count() FROM shop.payments" } }],
		truncated: false,
	},
	seenSecrets: [],
	prepared: [],
	runs: 0,
})

const secretOf = (connection: DriverConnection) =>
	connection.secret === null ? null : Redacted.value(connection.secret)

const sqlDriver = (world: World) =>
	registerDriver<"clickhouse">({
		kind: "clickhouse",
		queryLanguage: "sql:clickhouse",
		validateConnection: (input, previous) =>
			input._tag !== "clickhouse"
				? Effect.fail(new DataSourceValidationError({ message: "wrong kind" }))
				: Effect.succeed({
						config: {
							_tag: "clickhouse",
							url: input.url,
							user: input.user,
							database: input.database,
						} satisfies ClickHouseDataSourceConfig,
						secret: input.password ?? (previous === null ? "" : null),
					}),
		test: (connection) => {
			world.seenSecrets.push(secretOf(connection))
			return world.testFails
				? Effect.fail(new DataSourceConnectionError({ message: "connection refused", reason: "refused" }))
				: Effect.succeed({ warnings: ["The user can write"] })
		},
		catalog: () => Effect.succeed(world.sqlCatalog),
		prepare: (connection, query, request, catalog) => {
			world.prepared.push({ request, entries: catalog.entries.map((entry) => entry.name) })
			return Effect.succeed({
				summary: { _tag: "sql", sql: query._tag === "sql" ? query.sql : "" },
				run: () =>
					Effect.sync(() => {
						world.runs += 1
						world.seenSecrets.push(secretOf(connection))
						return { columns: [{ name: "n", type: "number" }], rows: [{ n: 3 }], truncated: false }
					}),
			})
		},
	})

const apiDriver = registerDriver<"clerk">({
	kind: "clerk",
	queryLanguage: "resource",
	validateConnection: () =>
		Effect.succeed({ config: { _tag: "clerk", instance: "development" } satisfies ClerkDataSourceConfig, secret: SECRET }),
	test: () => Effect.succeed({ warnings: [] }),
	catalog: () =>
		Effect.succeed({
			entries: [
				{
					name: "users",
					kind: "resource",
					timeField: "created_at",
					fields: [{ name: "created_at", type: "timestamp", note: "Signup time" }],
				},
			],
			examples: [],
			truncated: false,
		}),
	prepare: () =>
		Effect.succeed({
			summary: { _tag: "resource", strategy: "count", calls: 1, maxRows: 0, description: "1 count call" },
			run: () => Effect.succeed({ columns: [], rows: [], truncated: false }),
		}),
})

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
	}),
)

const makeLayer = (world: World, testDb: TestDb = createTestDb(createdDbs)) =>
	Layer.mergeAll(
		ExternalDataSourceService.layer.pipe(
			Layer.provide(DataSourceDrivers.fromList([sqlDriver(world), apiDriver])),
			Layer.provide(DataSourceCallBudget.unlimited),
			Layer.provide(Env.layer),
			Layer.provide(config),
		),
		FetchHttpClient.layer,
	).pipe(Layer.provideMerge(testDb.layer))

const shopProd = {
	name: "shop-prod",
	description: "Production storefront database: orders and payments",
	environment: "production",
	connection: { _tag: "clickhouse", url: "https://ch.example.com:8443", user: "reader", database: "shop", password: SECRET },
} as const

const window = { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 10, 8), workload: "interactive" } as const

describe("ExternalDataSourceService", () => {
	it.effect("saves nothing when the connection test fails", () => {
		const world = makeWorld()
		world.testFails = true
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const error = yield* service.create(ORG, USER, shopProd).pipe(Effect.flip)
			expect(error.message).toBe("Could not connect: connection refused")
			expect(yield* service.list(ORG, { agent: false })).toEqual([])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("stores the secret encrypted, hands it to the driver, and captures the catalog", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			expect(created).toMatchObject({
				name: "shop-prod",
				queryLanguage: "sql:clickhouse",
				secretHint: "1234",
				status: "ok",
				catalogEntryCount: 2,
			})

			const database = yield* Database
			const [row] = yield* database.execute((db) => db.run(PG.from(ExternalDataSources).select()))
			expect(row?.secretCiphertext).not.toContain(SECRET)
			expect(JSON.stringify(row)).not.toContain(SECRET)

			const result = yield* service.query(ORG, "shop-prod", { _tag: "sql", sql: "SELECT 1" }, window, {
				agent: false,
			})
			expect(result).toMatchObject({ rows: [{ n: 3 }], executed: true, language: "sql:clickhouse" })
			expect(world.seenSecrets).toEqual([SECRET, SECRET])
			// Another org cannot see it at all.
			expect(yield* service.list(OTHER_ORG, { agent: false })).toEqual([])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("keeps admin curation across a refresh and drops entries the source lost", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.payments", {
				exposed: false,
				note: "Amounts in cents",
				fieldNotes: { status: "paid, failed, refunded" },
			})
			world.sqlCatalog = { ...world.sqlCatalog, entries: [world.sqlCatalog.entries[0]] }
			const refreshed = yield* service.refreshCatalog(ORG, created.id)
			expect(refreshed.catalogEntryCount).toBe(1)

			const view = yield* service.catalog(ORG, "shop-prod", { agent: false })
			expect(view.entries).toHaveLength(1)
			expect(view.entries[0]).toMatchObject({ name: "shop.payments", exposed: false, note: "Amounts in cents" })
			expect(view.entries[0]?.fields.find((field) => field.name === "status")?.note).toBe("paid, failed, refunded")
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("shows agents only what the admin allowed", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const shop = yield* service.create(ORG, USER, shopProd)
			yield* service.create(ORG, USER, {
				name: "clerk-dev",
				description: "Development user accounts",
				environment: "development",
				agentAccess: false,
				connection: { _tag: "clerk", secretKey: SECRET },
			})
			yield* service.updateCatalogEntry(ORG, shop.id, "shop.orders", { exposed: false })

			const forAgents = yield* service.list(ORG, { agent: true })
			expect(forAgents.map((source) => source.name)).toEqual(["shop-prod"])
			const hidden = yield* service.get(ORG, "clerk-dev", { agent: true }).pipe(Effect.flip)
			expect(hidden._tag).toBe("@maple/data-sources/NotFound")

			const view = yield* service.catalog(ORG, "shop-prod", { agent: true })
			expect(view.entries.map((entry) => entry.name)).toEqual(["shop.payments"])
			const email = view.entries[0]?.fields.find((field) => field.name === "email")
			expect(email?.sampleValues).toEqual([])

			expect(yield* service.search(ORG, "orders", { agent: true })).toEqual([])
			// People still see the hidden entry in the catalog, where they can expose it again.
			const forPeople = yield* service.catalog(ORG, "shop-prod", { agent: false })
			expect(forPeople.entries.map((entry) => [entry.name, entry.exposed])).toEqual([
				["shop.orders", false],
				["shop.payments", true],
			])

			yield* service.query(ORG, "shop-prod", { _tag: "sql", sql: "SELECT 1" }, window, { agent: true })
			expect(world.prepared.at(-1)?.request.redactPii).toBe(true)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("names the right query form, suggests names, and explains without running", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			yield* service.create(ORG, USER, shopProd)
			yield* service.create(ORG, USER, {
				name: "clerk-prod",
				description: "Production user accounts",
				environment: "production",
				connection: { _tag: "clerk", secretKey: SECRET },
			})

			const sqlToApi = yield* service
				.query(ORG, "clerk-prod", { _tag: "sql", sql: "SELECT count(*) FROM users" }, window, { agent: true })
				.pipe(Effect.flip)
			expect(sqlToApi.message).toContain("takes a resource query, not SQL")

			const missing = yield* service
				.query(ORG, "shop-prd", { _tag: "sql", sql: "SELECT 1" }, window, { agent: true })
				.pipe(Effect.flip)
			expect(missing._tag === "@maple/data-sources/NotFound" ? missing.suggestions : []).toContain("shop-prod")

			const explained = yield* service.query(
				ORG,
				"shop-prod",
				{ _tag: "sql", sql: "SELECT 1" },
				{ ...window, explain: true },
				{ agent: true },
			)
			expect(explained).toMatchObject({ executed: false, plan: { _tag: "sql", sql: "SELECT 1" } })
			expect(world.runs).toBe(0)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("refuses a second source with the same name", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			yield* service.create(ORG, USER, shopProd)
			const error = yield* service.create(ORG, USER, shopProd).pipe(Effect.flip)
			expect(error._tag).toBe("@maple/data-sources/Validation")
		}).pipe(Effect.provide(makeLayer(world)))
	})
})
