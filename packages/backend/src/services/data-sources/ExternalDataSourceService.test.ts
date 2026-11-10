import { afterEach, describe, expect, it } from "@effect/vitest"
import { registerDriver, type QueryRequest, type DriverConnection } from "@maple/data-sources"
import {
	DataSourceConnectionError,
	DataSourceRateLimitedError,
	DataSourceValidationError,
	type CatalogEntry,
	type ClerkDataSourceConfig,
	type ClickHouseDataSourceConfig,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import { OrgId, UserId } from "@maple/primitives"
import { ExternalDataSources } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	Array as Arr,
	ConfigProvider,
	Effect,
	Layer,
	Option,
	Order,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { encryptAes256Gcm } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { DataSourceCallBudget, DataSourceDrivers } from "./DataSourceDrivers"
import { ExternalDataSourceService, MAX_CATALOG_ENTRIES } from "./ExternalDataSourceService"

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
	/** Every catalog a driver planned against. */
	readonly planned: Array<SourceCatalog>
	/** Calls the fake API made, and whether Clerk-style 429s come back. */
	apiCalls: number
	apiThrottled: boolean
	/** When set, the SQL driver answers one row holding this text. */
	wideCell: string | null
}

const table = (name: string, fields: CatalogEntry["fields"]): CatalogEntry => ({
	name,
	kind: "table",
	fields,
})

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
		examples: [
			{ title: "Failed payments", query: { _tag: "sql", sql: "SELECT count() FROM shop.payments" } },
		],
		truncated: false,
	},
	seenSecrets: [],
	prepared: [],
	runs: 0,
	planned: [],
	apiCalls: 0,
	apiThrottled: false,
	wideCell: null,
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
				? Effect.fail(
						new DataSourceConnectionError({ message: "connection refused", reason: "refused" }),
					)
				: Effect.succeed({ warnings: ["The user can write"] })
		},
		catalog: () => Effect.succeed(world.sqlCatalog),
		prepare: (connection, query, request, catalog) => {
			world.prepared.push({ request, entries: Arr.map(catalog.entries, (entry) => entry.name) })
			world.planned.push(catalog)
			return Effect.succeed({
				summary: { _tag: "sql", sql: query._tag === "sql" ? query.sql : "" },
				run: () =>
					Effect.sync(() => {
						world.runs += 1
						world.seenSecrets.push(secretOf(connection))
						return world.wideCell === null
							? { columns: [{ name: "n", type: "number" }], rows: [{ n: 3 }], truncated: false }
							: {
									columns: [{ name: "s", type: "string" }],
									rows: [{ s: world.wideCell }],
									truncated: false,
								}
					}),
			})
		},
	})

const apiDriver = (world: World) =>
	registerDriver<"clerk">({
		kind: "clerk",
		queryLanguage: "resource",
		validateConnection: () =>
			Effect.succeed({
				config: { _tag: "clerk", instance: "development" } satisfies ClerkDataSourceConfig,
				secret: SECRET,
			}),
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
				summary: {
					_tag: "resource",
					strategy: "count",
					calls: 1,
					maxRows: 0,
					description: "1 count call",
				},
				run: (context) =>
					Effect.andThen(
						context.spend(1),
						Effect.suspend(() => {
							world.apiCalls += 1
							return world.apiThrottled
								? Effect.fail(
										new DataSourceRateLimitedError({
											message: "429",
											retryAfterSeconds: 30,
										}),
									)
								: Effect.succeed({ columns: [], rows: [], truncated: false })
						}),
					),
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
			Layer.provide(DataSourceDrivers.fromList([sqlDriver(world), apiDriver(world)])),
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
	connection: {
		_tag: "clickhouse",
		url: "https://ch.example.com:8443",
		user: "reader",
		database: "shop",
		password: SECRET,
	},
} as const

const window = {
	startMs: Date.UTC(2026, 10, 1),
	endMs: Date.UTC(2026, 10, 8),
	workload: "interactive",
} as const

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
			expect(yield* service.list(OTHER_ORG, { agent: false })).toEqual([])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("opens a secret stored before secrets were sealed per slot, then a replaced one", () => {
		const world = makeWorld()
		const sql = { _tag: "sql", sql: "SELECT 1" } as const
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			const stored = yield* encryptAes256Gcm(
				"sk_stored_earlier",
				Buffer.alloc(32, 7),
				(message) => message,
				Buffer.from(`external_data_sources:v1:${ORG}:${created.id}`, "utf8"),
			)
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.update(ExternalDataSources)
						.set({
							secretCiphertext: stored.ciphertext,
							secretIv: stored.iv,
							secretTag: stored.tag,
						})
						.where(($) => [$.id.eq(created.id)]),
				),
			)
			yield* service.query(ORG, "shop-prod", sql, window, { agent: false })
			expect(world.seenSecrets.at(-1)).toBe("sk_stored_earlier")

			yield* service.update(ORG, USER, created.id, {
				connection: { ...shopProd.connection, password: "sk_replaced_later" },
			})
			yield* service.query(ORG, "shop-prod", sql, window, { agent: false })
			expect(world.seenSecrets.at(-1)).toBe("sk_replaced_later")
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
			expect(view.entries[0]).toMatchObject({
				name: "shop.payments",
				exposed: false,
				note: "Amounts in cents",
			})
			expect(
				Arr.findFirst(view.entries[0]?.fields ?? [], (field) => field.name === "status").pipe(
					Option.map((field) => field.note),
					Option.getOrUndefined,
				),
			).toBe("paid, failed, refunded")
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
			expect(Arr.map(forAgents, (source) => source.name)).toEqual(["shop-prod"])
			const hidden = yield* service.get(ORG, "clerk-dev", { agent: true }).pipe(Effect.flip)
			expect(hidden._tag).toBe("@maple/data-sources/NotFound")

			const view = yield* service.catalog(ORG, "shop-prod", { agent: true })
			expect(Arr.map(view.entries, (entry) => entry.name)).toEqual(["shop.payments"])
			const email = Arr.findFirst(view.entries[0]?.fields ?? [], (field) => field.name === "email")
			expect(Option.map(email, (field) => field.sampleValues)).toEqual(Option.some([]))

			expect(yield* service.search(ORG, "orders", { agent: true })).toEqual([])
			// People still see the hidden entry in the catalog, where they can expose it again.
			const forPeople = yield* service.catalog(ORG, "shop-prod", { agent: false })
			expect(Arr.map(forPeople.entries, (entry) => [entry.name, entry.exposed])).toEqual([
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
				.query(ORG, "clerk-prod", { _tag: "sql", sql: "SELECT count(*) FROM users" }, window, {
					agent: true,
				})
				.pipe(Effect.flip)
			expect(sqlToApi.message).toContain("takes a resource query, not SQL")

			const missing = yield* service
				.query(ORG, "shop-prd", { _tag: "sql", sql: "SELECT 1" }, window, { agent: true })
				.pipe(Effect.flip)
			expect(missing._tag === "@maple/data-sources/NotFound" ? missing.suggestions : []).toContain(
				"shop-prod",
			)

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

	it.effect("keeps a hidden entry hidden when it drops out of the source and comes back", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.orders", { exposed: false })
			const full = world.sqlCatalog
			world.sqlCatalog = { ...full, entries: [] }
			const emptied = yield* service.refreshCatalog(ORG, created.id)
			expect(emptied.catalogEntryCount).toBe(0)
			world.sqlCatalog = full
			yield* service.refreshCatalog(ORG, created.id)
			const view = yield* service.catalog(ORG, "shop-prod", { agent: false })
			expect(Arr.map(view.entries, (entry) => [entry.name, entry.exposed])).toEqual([
				["shop.orders", false],
				["shop.payments", true],
			])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("hands agents' queries only the entries they may see", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.orders", { exposed: false })
			const sql = { _tag: "sql", sql: "SELECT 1" } as const
			yield* service.query(ORG, "shop-prod", sql, window, { agent: true })
			expect(world.prepared.at(-1)?.entries).toEqual(["shop.payments"])
			yield* service.query(ORG, "shop-prod", sql, window, { agent: false })
			expect(Arr.sort(world.prepared.at(-1)?.entries ?? [], Order.String)).toEqual([
				"shop.orders",
				"shop.payments",
			])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("shows no hint for a short password", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, {
				...shopProd,
				connection: { ...shopProd.connection, password: "hunter2" },
			})
			expect(created.secretHint).toBeNull()
			expect(created.hasSecret).toBe(true)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("refuses a time grid too fine to build, before reaching the driver", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			yield* service.create(ORG, USER, shopProd)
			const error = yield* service
				.query(
					ORG,
					"shop-prod",
					{ _tag: "sql", sql: "SELECT 1" },
					{ ...window, granularitySeconds: 1 },
					{ agent: true },
				)
				.pipe(Effect.flip)
			expect(error._tag).toBe("@maple/data-sources/Validation")
			expect(world.prepared).toHaveLength(0)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("stops calling a source that answered 429 until its Retry-After passes", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			yield* service.create(ORG, USER, {
				name: "clerk-prod",
				description: "Production user accounts",
				environment: "production",
				connection: { _tag: "clerk", secretKey: SECRET },
			})
			const count = { _tag: "resource", resource: "users", measure: { fn: "count" } } as const
			world.apiThrottled = true
			yield* service.query(ORG, "clerk-prod", count, window, { agent: true }).pipe(Effect.flip)
			expect(world.apiCalls).toBe(1)
			world.apiThrottled = false
			const second = yield* service
				.query(ORG, "clerk-prod", count, window, { agent: true })
				.pipe(Effect.flip)
			expect(second).toMatchObject({ _tag: "@maple/data-sources/RateLimited" })
			expect(world.apiCalls).toBe(1)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("keeps field notes on an entry that drops out of the source and comes back", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.orders", {
				fieldNotes: { id: "order id" },
			})
			const full = world.sqlCatalog
			world.sqlCatalog = { ...full, entries: [] }
			yield* service.refreshCatalog(ORG, created.id)
			world.sqlCatalog = full
			yield* service.refreshCatalog(ORG, created.id)
			const view = yield* service.catalog(ORG, "shop-prod", { agent: false })
			const orders = Arr.findFirst(view.entries, (entry) => entry.name === "shop.orders")
			expect(Option.map(orders, (entry) => entry.fields[0]?.note)).toEqual(Option.some("order id"))
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("never shows agents an example that names a hidden entry", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.payments", { exposed: false })
			expect((yield* service.catalog(ORG, "shop-prod", { agent: true })).examples).toEqual([])
			expect((yield* service.catalog(ORG, "shop-prod", { agent: false })).examples).toHaveLength(1)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("refuses a result over the byte cap", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			yield* service.create(ORG, USER, shopProd)
			world.wideCell = Str.repeat(6_000_000)("x")
			const error = yield* service
				.query(ORG, "shop-prod", { _tag: "sql", sql: "SELECT s FROM t" }, window, { agent: false })
				.pipe(Effect.flip)
			expect(error._tag).toBe("@maple/data-sources/Limit")
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("lets an admin clear a detected note or time field, or go back to it", () => {
		const world = makeWorld()
		world.sqlCatalog = {
			...world.sqlCatalog,
			entries: [{ ...world.sqlCatalog.entries[0], note: "Card payments", timeField: "created_at" }],
		}
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			const cleared = yield* service.updateCatalogEntry(ORG, created.id, "shop.payments", {
				note: "",
				timeField: "",
			})
			expect([cleared.note, cleared.timeField]).toEqual([undefined, undefined])
			const restored = yield* service.updateCatalogEntry(ORG, created.id, "shop.payments", {
				note: null,
				timeField: null,
			})
			expect([restored.note, restored.timeField]).toEqual(["Card payments", "created_at"])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("keeps the stored password on an update without one, and refuses a change of kind", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			const { password: _password, ...withoutPassword } = shopProd.connection
			yield* service.update(ORG, USER, created.id, {
				description: "Storefront, read replica",
				connection: { ...withoutPassword, user: "reader2" },
			})
			yield* service.query(ORG, "shop-prod", { _tag: "sql", sql: "SELECT 1" }, window, { agent: false })
			expect(world.seenSecrets.at(-1)).toBe(SECRET)
			const kindChange = yield* service
				.update(ORG, USER, created.id, { connection: { _tag: "clerk", secretKey: SECRET } })
				.pipe(Effect.flip)
			expect(kindChange._tag).toBe("@maple/data-sources/Validation")
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("records a failed test on the source, and a delete stays inside the org", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const mine = yield* service.create(ORG, USER, shopProd)
			yield* service.create(OTHER_ORG, USER, shopProd)
			world.testFails = true
			const result = yield* service.test(ORG, mine.id)
			expect(result).toMatchObject({ ok: false, error: "connection refused" })
			expect(yield* service.get(ORG, "shop-prod", { agent: false })).toMatchObject({
				status: "error",
				lastError: "connection refused",
			})
			yield* service.remove(ORG, mine.id)
			expect(yield* service.list(ORG, { agent: false })).toEqual([])
			expect(Arr.map(yield* service.list(OTHER_ORG, { agent: false }), (s) => s.name)).toEqual([
				"shop-prod",
			])
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("counts only the entries an agent can see when it gets a source", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.orders", { exposed: false })
			expect((yield* service.get(ORG, "shop-prod", { agent: true })).catalogEntryCount).toBe(1)
			expect((yield* service.get(ORG, "shop-prod", { agent: false })).catalogEntryCount).toBe(2)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("never sends a stored password to a new host", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			const { password: _password, ...withoutPassword } = shopProd.connection
			const before = world.seenSecrets.length
			const moved = yield* service
				.update(ORG, USER, created.id, {
					connection: { ...withoutPassword, url: "https://attacker.example.net:8443" },
				})
				.pipe(Effect.flip)
			expect(moved).toMatchObject({ _tag: "@maple/data-sources/Validation", field: "connection" })
			expect(world.seenSecrets.length).toBe(before)
			// Same host, new user: the stored password stays on that server, so it is kept.
			yield* service.update(ORG, USER, created.id, {
				connection: { ...withoutPassword, user: "reader2" },
			})
			expect(world.seenSecrets.at(-1)).toBe(SECRET)
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("never hands a driver PII samples when planning for an agent without PII access", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			yield* service.create(ORG, USER, shopProd)
			yield* service.query(ORG, "shop-prod", { _tag: "sql", sql: "SELECT 1" }, window, { agent: true })
			expect(JSON.stringify(world.planned.at(-1))).not.toContain("ada@example.com")
			yield* service.query(ORG, "shop-prod", { _tag: "sql", sql: "SELECT 1" }, window, { agent: false })
			expect(JSON.stringify(world.planned.at(-1))).toContain("ada@example.com")
		}).pipe(Effect.provide(makeLayer(world)))
	})

	it.effect("reports a catalog cut at the cap as truncated even when an admin hid part of it", () => {
		const world = makeWorld()
		world.sqlCatalog = {
			...world.sqlCatalog,
			entries: Arr.makeBy(MAX_CATALOG_ENTRIES + 5, (i) =>
				table(`shop.t${i}`, [{ name: "id", type: "string" }]),
			),
			truncated: true,
		}
		return Effect.gen(function* () {
			const service = yield* ExternalDataSourceService
			const created = yield* service.create(ORG, USER, shopProd)
			yield* service.updateCatalogEntry(ORG, created.id, "shop.t0", { exposed: false })
			const forAgents = yield* service.get(ORG, "shop-prod", { agent: true })
			expect(forAgents).toMatchObject({
				catalogEntryCount: MAX_CATALOG_ENTRIES - 1,
				catalogTruncated: true,
			})
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
