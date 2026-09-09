// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import {
	MAX_RAW_SQL_RESULT_BYTES,
	OrgClickHouseSettingsEncryptionError,
	OrgClickHouseSettingsPersistenceError,
	OrgClickHouseSettingsStoredConfigInvalidError,
	OrgId,
	TinybirdOrgTokenConfigError,
	UserId,
	WarehouseConfigError,
	WarehouseInvalidSqlError,
	WarehouseResultDecodeError,
	WarehouseScopeError,
	WarehouseUpstreamError,
} from "@maple/domain/http"
import { FetchHttpClient } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { rawCompiledQuery } from "@maple/query-engine/ch"
import { parseStatement, type ClickHouseStatement } from "@maple-dev/effect-clickhouse/sql"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import {
	makeWarehouseExecutor,
	WarehouseDriverError,
	warehouseDriverFailure,
	WarehouseResponseLimitError,
	type ResolvedWarehouseConfig,
} from "@maple/query-engine/execution"
import * as ClickHouseHttp from "@maple-dev/effect-clickhouse-http"
import { __testables, WarehouseQueryService } from "./WarehouseQueryService"
import {
	OrgClickHouseSettingsService,
	type OrgClickHouseSettingsServiceApi,
} from "@/services/org/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import type { TenantContext } from "@/services/auth/AuthService"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(async () => {
	__testables.reset()
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = (extra: Record<string, string> = {}, includeTinybirdSigning = true) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			...(includeTinybirdSigning
				? {
						TINYBIRD_SIGNING_KEY: "test-signing-key",
						TINYBIRD_WORKSPACE_ID: "test-workspace",
					}
				: undefined),
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
			...extra,
		}),
	)

const buildLayer = (testDb: TestDb, extra: Record<string, string> = {}, includeTinybirdSigning = true) => {
	const configLive = makeConfig(extra, includeTinybirdSigning)
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = testDb.layer
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
	const orgSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive, edgeCacheLive)),
	)
	const tinybirdTokenLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(envLive))
	return WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, orgSettingsLive, tinybirdTokenLive)),
	)
}

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const makeTenant = (): TenantContext => ({
	orgId: asOrgId("org_test"),
	userId: asUserId("user_test"),
	roles: [],
	authMode: "self_hosted",
})

// A scoped stand-in for the removed `sqlQuery(tenant, sql)` entry point: these
// tests exercise retry/routing/caching, not scope, so the SQL travels wrapped in
// a compiled query that declares it.
const scopedSql = (sql: string) =>
	rawCompiledQuery<Record<string, unknown>>({
		sql,
		tenantScope: "single-tenant",
		reason: "test-fixture",
		justification: "Synthetic SQL asserting executor behaviour, not a product query.",
	})

const transient503 = () => new Error("HTTP status 503 service temporarily unavailable")

const decodeJwtPayload = (token: string): Record<string, unknown> =>
	JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
		string,
		unknown
	>

describe("WarehouseQueryService raw-SQL provider routing", () => {
	it.effect("substitutes a scoped JWT for the Tinybird SDK token", () => {
		let captured: ResolvedWarehouseConfig | undefined
		let responseLimits: { readonly maxRows: number; readonly maxBytes: number } | undefined
		__testables.setClientFactory((config) =>
			Effect.sync(() => {
				captured = config
				return {
					sql: (_sql, options) =>
						Effect.try({
							try: () => {
								responseLimits = options?.responseLimits
								return { data: [] }
							},
							catch: warehouseDriverFailure,
						}),
					insert: () => Effect.void,
				}
			}),
		)
		const layer = buildLayer(createTestDb(trackedDbs))

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
			)
			assert.strictEqual(captured?.kind, "tinybird")
			if (captured?.kind !== "tinybird") throw new Error("expected Tinybird config")
			assert.notStrictEqual(captured.token, "managed-token")
			assert.strictEqual(decodeJwtPayload(captured.token).workspace_id, "test-workspace")
			assert.deepStrictEqual(responseLimits, { maxRows: 1000, maxBytes: 5_000_000 })
		}).pipe(Effect.provide(layer))
	})

	it.effect("defaults an env-level ClickHouse gateway to Tinybird and substitutes a scoped JWT", () => {
		let captured: ResolvedWarehouseConfig | undefined
		__testables.setClientFactory((config) =>
			Effect.sync(() => {
				captured = config
				return { sql: () => Effect.succeed({ data: [] }), insert: () => Effect.void }
			}),
		)
		const layer = buildLayer(createTestDb(trackedDbs), {
			CLICKHOUSE_URL: "https://gateway.tinybird.example",
			CLICKHOUSE_PASSWORD: "gateway-admin-token",
		})

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
			)
			assert.strictEqual(captured?.kind, "tinybird-gateway")
			if (captured?.kind !== "tinybird-gateway") throw new Error("expected gateway config")
			assert.notStrictEqual(captured.password, "gateway-admin-token")
			assert.strictEqual(decodeJwtPayload(captured.password).workspace_id, "test-workspace")
		}).pipe(Effect.provide(layer))
	})

	it.effect("preserves env-level vanilla ClickHouse credentials for raw SQL", () => {
		let captured: ResolvedWarehouseConfig | undefined
		__testables.setClientFactory((config) =>
			Effect.sync(() => {
				captured = config
				return { sql: () => Effect.succeed({ data: [] }), insert: () => Effect.void }
			}),
		)
		const layer = buildLayer(createTestDb(trackedDbs), {
			CLICKHOUSE_URL: "https://clickhouse.example",
			CLICKHOUSE_PROVIDER: "clickhouse",
			CLICKHOUSE_PASSWORD: "original-clickhouse-password",
		})

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
			)
			assert.strictEqual(captured?.kind, "clickhouse")
			if (captured?.kind !== "clickhouse") throw new Error("expected ClickHouse config")
			assert.strictEqual(captured.password, "original-clickhouse-password")
		}).pipe(Effect.provide(layer))
	})

	it.effect("fails closed for env-level vanilla ClickHouse outside self-hosted mode", () => {
		let constructed = false
		__testables.setClientFactory(() =>
			Effect.sync(() => {
				constructed = true
				return { sql: () => Effect.succeed({ data: [] }), insert: () => Effect.void }
			}),
		)
		const layer = buildLayer(createTestDb(trackedDbs), {
			CLICKHOUSE_URL: "https://clickhouse.example",
			CLICKHOUSE_PROVIDER: "clickhouse",
			CLICKHOUSE_PASSWORD: "shared-password",
			MAPLE_AUTH_MODE: "clerk",
			CLERK_SECRET_KEY: "sk_test_raw_sql",
		})

		return Effect.gen(function* () {
			const error = yield* Effect.flip(
				WarehouseQueryService.use((service) =>
					service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
				),
			)
			assert.instanceOf(error, WarehouseConfigError)
			assert.include(error.message, "single-org self-hosted mode")
			assert.isFalse(constructed)
		}).pipe(Effect.provide(layer))
	})

	it.effect("preserves per-org ClickHouse override credentials for raw SQL", () => {
		let captured: ResolvedWarehouseConfig | undefined
		__testables.setClientFactory((config) =>
			Effect.sync(() => {
				captured = config
				return { sql: () => Effect.succeed({ data: [] }), insert: () => Effect.void }
			}),
		)
		// BYO credentials are already tenant-isolated and must not require the
		// managed Tinybird JWT signing configuration.
		const configLive = makeConfig({}, false)
		const envLive = Env.layer.pipe(Layer.provide(configLive))
		const tokenLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(envLive))
		// Partial stub: the cast hides absent members from the compiler, so a
		// method the executor calls at runtime fails as "not a function" rather
		// than as a type error. `invalidateRuntimeConfig` is stubbed because
		// `WarehouseQueryService` wires it into the executor's auth self-heal —
		// unreachable in this test, but only until someone makes the fake client
		// throw an auth error.
		const orgSettingsLive = Layer.succeed(OrgClickHouseSettingsService, {
			resolveRuntimeConfig: () =>
				Effect.succeed(
					Option.some({
						backend: "clickhouse" as const,
						url: "https://byo.example",
						user: "byo-user",
						password: "byo-password",
						database: "maple",
					}),
				),
			invalidateRuntimeConfig: () => Effect.succeed(false),
		} as OrgClickHouseSettingsServiceApi)
		const layer = WarehouseQueryService.layer.pipe(
			Layer.provide(Layer.mergeAll(envLive, tokenLive, orgSettingsLive)),
		)

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
			)
			assert.strictEqual(captured?.kind, "clickhouse")
			if (captured?.kind !== "clickhouse") throw new Error("expected ClickHouse config")
			assert.strictEqual(captured.password, "byo-password")
		}).pipe(Effect.provide(layer))
	})

	it.effect("preserves exact runtime-config dependency failures", () => {
		const cases = [
			{
				source: new OrgClickHouseSettingsPersistenceError({ message: "database unavailable" }),
			},
			{
				source: new OrgClickHouseSettingsEncryptionError({ message: "decrypt failed" }),
			},
			{
				source: new OrgClickHouseSettingsStoredConfigInvalidError({
					message: "invalid stored URL",
					cause: new Error("invalid stored URL"),
				}),
			},
		] as const

		return Effect.forEach(
			cases,
			({ source }) => {
				const configLive = makeConfig({}, false)
				const envLive = Env.layer.pipe(Layer.provide(configLive))
				const tokenLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(envLive))
				const orgSettingsLive = Layer.succeed(OrgClickHouseSettingsService, {
					resolveRuntimeConfig: () => Effect.fail(source),
					invalidateRuntimeConfig: () => Effect.succeed(false),
				} as OrgClickHouseSettingsServiceApi)
				const layer = WarehouseQueryService.layer.pipe(
					Layer.provide(Layer.mergeAll(envLive, tokenLive, orgSettingsLive)),
				)

				return Effect.gen(function* () {
					const exit = yield* WarehouseQueryService.use((service) =>
						service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
					).pipe(Effect.exit)
					assert.strictEqual(getError(exit), source)
				}).pipe(Effect.provide(layer))
			},
			{ discard: true },
		)
	})

	it.effect("preserves missing Tinybird signing configuration as its own tag", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [] }),
			insert: () => Effect.void,
		}))
		const layer = buildLayer(createTestDb(trackedDbs), {}, false)

		return Effect.gen(function* () {
			const exit = yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
			).pipe(Effect.exit)
			const failure = getError(exit)
			assert.instanceOf(failure, TinybirdOrgTokenConfigError)
			assert.include((failure as TinybirdOrgTokenConfigError).message, "TINYBIRD_SIGNING_KEY")
			assert.notInclude((failure as TinybirdOrgTokenConfigError).message, "managed-token")
		}).pipe(Effect.provide(layer))
	})

	it.effect("rejects env-level URL userinfo before constructing a client", () => {
		let constructed = false
		__testables.setClientFactory(() =>
			Effect.sync(() => {
				constructed = true
				return { sql: () => Effect.succeed({ data: [] }), insert: () => Effect.void }
			}),
		)
		const layer = buildLayer(createTestDb(trackedDbs), {
			CLICKHOUSE_URL: "https://user:secret@clickhouse.example",
			CLICKHOUSE_PROVIDER: "clickhouse",
		})

		return Effect.gen(function* () {
			const exit = yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(makeTenant(), "SELECT 1 WHERE OrgId = 'org_test'"),
			).pipe(Effect.exit)
			assert.instanceOf(getError(exit), WarehouseConfigError)
			assert.isFalse(constructed)
		}).pipe(Effect.provide(layer))
	})
})

describe("bounded Tinybird response body", () => {
	const tbConfig = { kind: "tinybird" as const, host: "https://api.tinybird.example", token: "tok" }
	const limits = { maxRows: 1000, maxBytes: MAX_RAW_SQL_RESULT_BYTES }
	const bodyOf = (bytes: number) => {
		// A valid result set padded to exactly `bytes` with trailing whitespace.
		const prefix = '{"data":[]}'
		return prefix + " ".repeat(bytes - prefix.length)
	}

	it.effect("accepts an exact-boundary response and refuses one byte over", () =>
		Effect.gen(function* () {
			const exact = makeTinybirdTestClient(tbConfig, async () => new Response(bodyOf(MAX_RAW_SQL_RESULT_BYTES)))
			const result = yield* exact.sql(parseStatement("SELECT 1 FORMAT JSON"), { responseLimits: limits })
			assert.deepStrictEqual(result.data, [])

			const over = makeTinybirdTestClient(
				tbConfig,
				async () => new Response(bodyOf(MAX_RAW_SQL_RESULT_BYTES + 1)),
			)
			const error = yield* Effect.flip(
				over.sql(parseStatement("SELECT 1 FORMAT JSON"), { responseLimits: limits }),
			)
			assert.instanceOf(error, WarehouseResponseLimitError)
			assert.strictEqual((error as WarehouseResponseLimitError).kind, "bytes")
			assert.match(error.message, /5000000 encoded bytes/)
		}),
	)
})

describe("WarehouseQueryService.compiledQuery retry on transient upstream failures", () => {
	// Runs under it.live: the retry schedule uses real exponential backoff
	// delays, so the default TestClock would stall the retries.
	it.live("recovers after two 503s on the third attempt", () => {
		let attempts = 0
		__testables.setClientFactory(() => Effect.succeed({
			sql: () =>
				Effect.try({
					try: () => {
						attempts++
						if (attempts < 3) throw transient503()
						return { data: [{ ok: 1 }] }
					},
					catch: warehouseDriverFailure,
				}),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQuery(tenant, scopedSql("SELECT 1 FROM traces WHERE OrgId = 'org_test'")),
			)

			assert.strictEqual(attempts, 3)
			assert.deepStrictEqual(result, [{ ok: 1 }])
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not retry non-transient errors (auth)", () => {
		let attempts = 0
		__testables.setClientFactory(() => Effect.succeed({
			sql: () =>
				Effect.try({
					try: () => {
						attempts++
						throw new Error("HTTP status 401 authentication failed")
					},
					catch: warehouseDriverFailure,
				}),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) =>
					service.compiledQuery(tenant, scopedSql("SELECT 1 FROM traces WHERE OrgId = 'org_test'")),
				),
			)

			assert.strictEqual(attempts, 1)
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(Effect.provide(layer))
	})

	// Runs under it.live: exhausts the real backoff schedule before giving up.
	it.live("gives up after the configured retry budget when all attempts fail", () => {
		let attempts = 0
		__testables.setClientFactory(() => Effect.succeed({
			sql: () =>
				Effect.try({
					try: () => {
						attempts++
						throw transient503()
					},
					catch: warehouseDriverFailure,
				}),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) =>
					service.compiledQuery(tenant, scopedSql("SELECT 1 FROM traces WHERE OrgId = 'org_test'")),
				),
			)

			// 1 initial + 2 retries
			assert.strictEqual(attempts, 3)
			assert.isTrue(Exit.isFailure(exit))

			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseUpstreamError)
			assert.strictEqual((failure as WarehouseUpstreamError).upstreamStatus, 503)
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseQueryService.compiledQuery", () => {
	const RowNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

	it.effect("executes compiled SQL and decodes rows with the compiled row schema", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [{ serviceName: "api", count: "42" }] }),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = rawCompiledQuery<{ readonly serviceName: string; readonly count: number }>({
			reason: "test-fixture",
			justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
			tenantScope: "single-tenant",
			sql: "SELECT ServiceName AS serviceName, count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ serviceName: Schema.String, count: RowNumber }),
		})

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQuery(tenant, compiled),
			)

			assert.deepStrictEqual(result, [{ serviceName: "api", count: 42 }])
		}).pipe(Effect.provide(layer))
	})

	it.effect("maps row decode failures to WarehouseResultDecodeError", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [{ count: "not-a-number" }] }),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = rawCompiledQuery<{ readonly count: number }>({
			reason: "test-fixture",
			justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
			tenantScope: "single-tenant",
			sql: "SELECT count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.compiledQuery(tenant, compiled)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseResultDecodeError)
		}).pipe(Effect.provide(layer))
	})

	it.effect("still enforces OrgId scoping for compiled SQL", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [{ count: 1 }] }),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		// No top-level OrgId predicate. Previously expressed as SQL lacking the
		// substring "OrgId"; scope is now a property of the compiled query, so a
		// query that merely mentions the column can no longer sneak through.
		const compiled = rawCompiledQuery<{ readonly count: number }>({
			reason: "test-fixture",
			justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
			sql: "SELECT count() AS count, 'x' AS OrgId FROM traces",
			tenantScope: "cross-tenant",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.compiledQuery(tenant, compiled)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseScopeError)
			assert.strictEqual(
				(failure as { message?: string } | undefined)?.message,
				"compiled query is not tenant-scoped: no top-level OrgId predicate (compiledQuery). " +
					"Deliberate cross-tenant reads must declare .crossTenant() and run through crossOrgQuery.",
			)
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseQueryService.compiledQueryFirst", () => {
	const RowNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

	it.effect("returns Some with the decoded first row", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () =>
				Effect.succeed({
					data: [
						{ serviceName: "api", count: "42" },
						{ serviceName: "worker", count: "9" },
					],
				}),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = rawCompiledQuery<{ readonly serviceName: string; readonly count: number }>({
			reason: "test-fixture",
			justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
			tenantScope: "single-tenant",
			sql: "SELECT ServiceName AS serviceName, count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ serviceName: Schema.String, count: RowNumber }),
		})

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQueryFirst(tenant, compiled),
			)

			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) {
				assert.deepStrictEqual(result.value, { serviceName: "api", count: 42 })
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("returns None when the compiled SQL returns no rows", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [] }),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = rawCompiledQuery<{ readonly count: number }>({
			reason: "test-fixture",
			justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
			tenantScope: "single-tenant",
			sql: "SELECT count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const result = yield* WarehouseQueryService.use((service) =>
				service.compiledQueryFirst(tenant, compiled),
			)

			assert.deepStrictEqual(result, Option.none())
		}).pipe(Effect.provide(layer))
	})

	it.effect("maps first-row decode failures to WarehouseResultDecodeError", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [{ count: "not-a-number" }] }),
			insert: () => Effect.void,
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const compiled = rawCompiledQuery<{ readonly count: number }>({
			reason: "test-fixture",
			justification: "Synthetic SQL asserting executor/compile behaviour, not a product query.",
			tenantScope: "single-tenant",
			sql: "SELECT count() AS count FROM traces WHERE OrgId = 'org_test'",
			rowSchema: Schema.Struct({ count: RowNumber }),
		})

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.compiledQueryFirst(tenant, compiled)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseResultDecodeError)
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseQueryService.ingest writes through the SQL client", () => {
	it.effect("forwards datasource + rows to the client's insert", () => {
		const calls: Array<{ datasource: string; rows: ReadonlyArray<unknown> }> = []
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [] }),
			insert: (datasource, rows) =>
				Effect.try({
					try: () => {
						calls.push({ datasource, rows })
					},
					catch: WarehouseDriverError.fromUnknown,
				}),
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()
		const rows = [{ trace_id: "a" }, { trace_id: "b" }]

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) => service.ingest(tenant, "traces", rows))

			assert.strictEqual(calls.length, 1)
			assert.strictEqual(calls[0]?.datasource, "traces")
			assert.deepStrictEqual(calls[0]?.rows, rows)
		}).pipe(Effect.provide(layer))
	})

	it.effect("short-circuits without calling insert when there are no rows", () => {
		let inserts = 0
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [] }),
			insert: () =>
				Effect.try({
					try: () => {
						inserts++
					},
					catch: WarehouseDriverError.fromUnknown,
				}),
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) => service.ingest(tenant, "traces", []))
			assert.strictEqual(inserts, 0)
		}).pipe(Effect.provide(layer))
	})

	// Inserts classify with the read path's default "caller" authorship (the
	// rows, not Maple's SQL, are what usually earned the rejection), so a
	// syntax-shaped complaint takes the caller-authored invalid-SQL tag.
	it.effect("maps a failed insert through the classifier", () => {
		__testables.setClientFactory(() => Effect.succeed({
			sql: () => Effect.succeed({ data: [] }),
			insert: () =>
				Effect.try({
					try: () => {
						throw new Error("HTTP 400 Bad Request: DB::Exception: Syntax error")
					},
					catch: WarehouseDriverError.fromUnknown,
				}),
		}))

		const layer = buildLayer(createTestDb(trackedDbs))
		const tenant = makeTenant()

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				WarehouseQueryService.use((service) => service.ingest(tenant, "traces", [{ trace_id: "a" }])),
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, WarehouseInvalidSqlError)
		}).pipe(Effect.provide(layer))
	})
})

describe("createClickHouseSqlClient.insert is disabled (ClickHouse is read-only)", () => {
	// ClickHouse only serves reads for Maple; ingest goes to Tinybird. The CH
	// client's insert must fail loudly so it can never silently 500 against the
	// read-only query gateway ("Only SELECT or DESCRIBE … Got: InsertQuery").
	const chConfig = {
		kind: "clickhouse" as const,
		url: "https://ch.example.com",
		username: "u",
		password: "p",
		database: "default",
	}

	it("throws — ingest must use Tinybird, never ClickHouse — and issues no request", async () => {
		let fetched = 0
		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => {
			fetched++
			return new Response("", { status: 200 })
		}) as typeof fetch

		let thrown: unknown
		try {
			const client = makeClickHouseTestClient(chConfig)
			await Effect.runPromise(client.insert("traces", [{ trace_id: "a" }]))
		} catch (error) {
			thrown = error
		} finally {
			globalThis.fetch = realFetch
		}

		assert.instanceOf(thrown, Error)
		assert.match((thrown as Error).message, /read-only|Tinybird/)
		assert.strictEqual(fetched, 0)
	})
})

describe("createTinybirdSqlClient.insert wire framing (the production insert path)", () => {
	// Inserts in the cloud only need to work on Tinybird. This pins that path so a
	// future change can't silently break ingest into the managed pipeline.
	const tbConfig = {
		kind: "tinybird" as const,
		host: "https://api.tinybird.co",
		token: "tok_123",
	}

	it("POSTs raw ndjson rows to the Tinybird Events API (/v0/events?name=<datasource>)", async () => {
		const captured: Array<{
			url: string
			method?: string
			contentType?: string
			auth?: string
			body: string
		}> = []
		const requestFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			captured.push({
				url: String(input),
				method: init?.method,
				contentType: headers.get("content-type") ?? undefined,
				auth: headers.get("authorization") ?? undefined,
				body: requestBodyText(init?.body),
			})
			return new Response("", { status: 202 })
		}) as typeof fetch

		const client = makeTinybirdTestClient(tbConfig, requestFetch)
		await Effect.runPromise(client.insert("traces", [{ trace_id: "a" }, { trace_id: "b" }]))

		assert.strictEqual(captured.length, 1)
		const req = captured[0]!
		assert.strictEqual(req.method, "POST")
		assert.isTrue(req.url.startsWith("https://api.tinybird.co/v0/events?name=traces"))
		assert.strictEqual(req.contentType, "application/x-ndjson")
		assert.strictEqual(req.auth, "Bearer tok_123")
		assert.strictEqual(req.body, '{"trace_id":"a"}\n{"trace_id":"b"}')
		// Tinybird ingests raw rows — never an `INSERT … FORMAT` statement (CH only).
		assert.isFalse(req.body.includes("INSERT INTO"))
	})

	it("no-ops on an empty row set (no request issued)", async () => {
		let calls = 0
		const requestFetch = (async () => {
			calls++
			return new Response("", { status: 202 })
		}) as typeof fetch

		const client = makeTinybirdTestClient(tbConfig, requestFetch)
		await Effect.runPromise(client.insert("traces", []))

		assert.strictEqual(calls, 0)
	})
})

describe("createTinybirdSqlClient.sql wire format", () => {
	// The FORMAT decision moved to the executor, which settles the statement's
	// terminal clauses from the backend's dialect before any driver sees it. This
	// driver's whole job is to render what it was handed — the double-FORMAT
	// syntax error that broke every alerting query against managed Tinybird can no
	// longer originate here, because nothing here inspects SQL text.
	const tbConfig = {
		kind: "tinybird" as const,
		host: "https://api.tinybird.co",
		token: "tok_123",
	}

	const captureSql = async (statement: ClickHouseStatement): Promise<string> => {
		const sent: string[] = []
		const requestFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input))
			if (url.pathname.endsWith("/v0/sql")) {
				const fromParam = url.searchParams.get("q")
				sent.push(fromParam ?? requestBodyText(init?.body))
			}
			return new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}) as typeof fetch

		const client = makeTinybirdTestClient(tbConfig, requestFetch)
		await Effect.runPromise(client.sql(statement, undefined))

		assert.strictEqual(sent.length, 1)
		return sent[0]!
	}

	it("sends the statement as the executor rendered it", async () => {
		const sent = await captureSql(parseStatement("SELECT 1\nFORMAT JSON"))
		assert.strictEqual(sent, "SELECT 1\nFORMAT JSON")
	})

	it("keeps SETTINGS ahead of FORMAT", async () => {
		const sent = await captureSql(parseStatement("SELECT 1 SETTINGS max_execution_time=15\nFORMAT JSON"))
		assert.strictEqual(sent, "SELECT 1\nSETTINGS max_execution_time=15\nFORMAT JSON")
	})

	it("does not add a format the executor left off", async () => {
		const sent = await captureSql(parseStatement("SELECT 1"))
		assert.strictEqual(sent, "SELECT 1")
	})

	it("leaves a nested FORMAT alone", async () => {
		const sent = await captureSql(parseStatement("SELECT * FROM (SELECT 1 FORMAT JSON) AS x"))
		assert.strictEqual(sent, "SELECT * FROM (SELECT 1 FORMAT JSON) AS x")
	})
})

describe("ingest routes writes to the managed pipeline, not a per-org read override", () => {
	const clickhouseReadOverride = {
		config: {
			kind: "clickhouse" as const,
			url: "https://byo-clickhouse.example.com",
			username: "u",
			password: "p",
			database: "d",
		},
		clientCacheKey: "read:org_test",
	}
	const tinybirdManaged = {
		config: {
			kind: "tinybird" as const,
			host: "https://managed.tinybird.co",
			token: "tok",
		},
		clientCacheKey: "write:managed",
	}

	it.effect("ingest routes with purpose 'ingest' (Tinybird) while reads route to the override", () => {
		const used: Array<{ op: "sql" | "insert"; kind: string }> = []
		const purposes: Array<string> = []
		const executor = makeWarehouseExecutor({
			createClient: (config) => Effect.succeed({
				sql: () =>
					Effect.try({
						try: () => {
							used.push({ op: "sql", kind: config.kind })
							return { data: [] }
						},
						catch: warehouseDriverFailure,
					}),
				insert: () =>
					Effect.try({
						try: () => {
							used.push({ op: "insert", kind: config.kind })
						},
						catch: WarehouseDriverError.fromUnknown,
					}),
			}),
			resolveRoute: (_tenant, purpose) => {
				purposes.push(purpose)
				return Effect.succeed(
					purpose === "ingest"
						? { source: "managed" as const, ...tinybirdManaged }
						: { source: "org-byo" as const, ...clickhouseReadOverride },
				)
			},
		})
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* executor.compiledQuery(tenant, scopedSql("SELECT 1 FROM traces WHERE OrgId = 'org_test'"))
			yield* executor.ingest(tenant, "traces", [{ trace_id: "a" }])

			assert.deepStrictEqual(purposes, ["read", "ingest"])
			assert.deepStrictEqual(used, [
				{ op: "sql", kind: "clickhouse" },
				{ op: "insert", kind: "tinybird" },
			])
		})
	})
})

describe("ingest pins writes to Tinybird even when CLICKHOUSE_URL makes managed reads ClickHouse", () => {
	// Reproduces the prod incident: CLICKHOUSE_URL is set, so the managed READ
	// backend is a read-only ClickHouse query gateway. Inserts there are rejected
	// ("Only SELECT or DESCRIBE queries are supported. Got: InsertQuery"). Writes
	// MUST resolve to Tinybird regardless. Routing ingest through the managed
	// resolver (which prefers ClickHouse) is what kept demo-seed onboarding broken.
	it.effect("reads resolve to managed ClickHouse, but ingest resolves to Tinybird", () => {
		const used: Array<{ op: "sql" | "insert"; kind: string }> = []
		__testables.setClientFactory((config) => Effect.succeed({
			sql: () =>
				Effect.try({
					try: () => {
						used.push({ op: "sql", kind: config.kind })
						return { data: [] }
					},
					catch: warehouseDriverFailure,
				}),
			insert: () =>
				Effect.try({
					try: () => {
						used.push({ op: "insert", kind: config.kind })
					},
					catch: WarehouseDriverError.fromUnknown,
				}),
		}))

		const layer = buildLayer(createTestDb(trackedDbs), {
			CLICKHOUSE_URL: "https://readonly-ch.example.com",
			CLICKHOUSE_USER: "reader",
			CLICKHOUSE_DATABASE: "default",
		})
		const tenant = makeTenant()

		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.compiledQuery(tenant, scopedSql("SELECT 1 FROM traces WHERE OrgId = 'org_test'")),
			)
			yield* WarehouseQueryService.use((service) =>
				service.ingest(tenant, "traces", [{ trace_id: "a" }]),
			)

			// CLICKHOUSE_PROVIDER defaults to "tinybird", so a bare CLICKHOUSE_URL is
			// the Tinybird CH-gateway.
			assert.deepStrictEqual(used, [
				{ op: "sql", kind: "tinybird-gateway" },
				{ op: "insert", kind: "tinybird" },
			])
		}).pipe(Effect.provide(layer))
	})
})

describe("WarehouseUpstreamError surfaces transient classification", () => {
	it("carries upstreamStatus on 503", () => {
		// Sanity check that the constructor flow we depend on for retry is intact.
		const err = new WarehouseUpstreamError({
			pipeName: "test",
			message: "upstream",
			upstreamStatus: 503,
		})
		assert.strictEqual(err.upstreamStatus, 503)
	})
})

describe("Tinybird response decoding", () => {
	const tbConfig = { kind: "tinybird" as const, host: "https://api.tinybird.co", token: "tok" }
	const statement = parseStatement("SELECT 1 FORMAT JSON")

	// A successful (2xx) query that matches zero rows can come back with an empty
	// body. That is zero rows, so alert rules (and every compiledQuery caller) hit
	// the no-data path instead of surfacing a spurious WarehouseClientError.
	it.effect("treats an empty 2xx body as zero rows", () =>
		Effect.gen(function* () {
			const client = makeTinybirdTestClient(tbConfig, async () => new Response("", { status: 200 }))
			assert.deepStrictEqual((yield* client.sql(statement)).data, [])
		}),
	)

	it.effect("reports an HTML error page as a protocol failure, not zero rows", () =>
		Effect.gen(function* () {
			const client = makeTinybirdTestClient(
				tbConfig,
				async () => new Response("<html>upstream</html>", { status: 200 }),
			)
			const error = yield* Effect.flip(client.sql(statement))
			assert.instanceOf(error, WarehouseDriverError)
			assert.strictEqual((error as WarehouseDriverError).reason, "protocol")
		}),
	)

	it.effect("lifts the JSON error field and the HTTP status off a rejected query", () =>
		Effect.gen(function* () {
			const client = makeTinybirdTestClient(
				tbConfig,
				async () =>
					new Response(JSON.stringify({ error: "invalid authentication token" }), { status: 403 }),
			)
			const error = yield* Effect.flip(client.sql(statement))
			assert.instanceOf(error, WarehouseDriverError)
			const driver = error as WarehouseDriverError
			assert.strictEqual(driver.reason, "server")
			assert.strictEqual(driver.status, 403)
			assert.strictEqual(driver.message, "invalid authentication token")
		}),
	)

	it.effect("keeps a non-JSON error body with its status", () =>
		Effect.gen(function* () {
			const client = makeTinybirdTestClient(
				tbConfig,
				async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
			)
			const error = yield* Effect.flip(client.sql(statement))
			assert.instanceOf(error, WarehouseDriverError)
			const driver = error as WarehouseDriverError
			assert.strictEqual(driver.status, 502)
			assert.match(driver.message, /^Request failed with status 502: /)
		}),
	)
})

describe("BYO ClickHouse redirect refusal", () => {
	// A BYO endpoint is validated when saved, not when used, so a target that
	// passed validation and then answers a query with a 307 must not be followed
	// into the internal network.
	const chConfig = {
		kind: "clickhouse" as const,
		url: "https://ch.example.com",
		username: "u",
		password: "p",
		database: "default",
	}

	it("refuses a 3xx from the query endpoint and never follows the Location", async () => {
		const seen: RequestInit[] = []
		const requestFetch: typeof fetch = async (_input, init) => {
			seen.push(init ?? {})
			return new Response("", { status: 307, headers: { location: "http://169.254.169.254/" } })
		}

		const client = makeClickHouseTestClient(chConfig, requestFetch)
		let thrown: unknown
		try {
			await Effect.runPromise(client.sql(parseStatement("SELECT 1"), undefined))
		} catch (error) {
			thrown = error
		}

		assert.instanceOf(thrown, WarehouseDriverError)
		const driver = thrown as WarehouseDriverError
		// A refused redirect is configuration, never an ordinary 4xx from the cluster.
		assert.strictEqual(driver.reason, "config")
		assert.strictEqual(driver.status, 307)
		assert.match(driver.message, /redirect responses are not allowed \(307\)/)
		// The Location is kept as context, so a refusal is diagnosable.
		assert.instanceOf(driver.cause, ClickHouseHttp.ClickHouseRedirectError)
		assert.strictEqual((driver.cause as ClickHouseHttp.ClickHouseRedirectError).location, "http://169.254.169.254/")
		// Exactly one request, and it opted out of automatic redirect following.
		assert.strictEqual(seen.length, 1)
		assert.strictEqual(seen[0]?.redirect, "manual")
	})

	it.effect("decodes an ordinary 2xx response through the native client", () =>
		Effect.gen(function* () {
			const requestFetch: typeof fetch = async () => new Response('{"n":1}\n', { status: 200 })
			const result = yield* makeClickHouseTestClient(chConfig, requestFetch).sql(
				parseStatement("SELECT 1"),
			)
			assert.deepStrictEqual(result.data, [{ n: 1 }])
		}),
	)
})

describe("warehouse driver Effect boundaries", () => {
	const chConfig = {
		kind: "clickhouse" as const,
		url: "https://ch.example.com",
		username: "u",
		password: "p",
		database: "default",
	}
	const tbConfig = { kind: "tinybird" as const, host: "https://api.tinybird.co", token: "token" }
	const cases = [
		{
			name: "ClickHouse",
			make: (request: typeof fetch) => makeClickHouseTestClient(chConfig, request),
		},
		{
			name: "Tinybird",
			make: (request: typeof fetch) => makeTinybirdTestClient(tbConfig, request),
		},
	]

	for (const { name, make } of cases) {
		it.effect(`${name} defers requests and cancels each concurrent execution independently`, () =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const signals: AbortSignal[] = []
				const request: typeof fetch = (_input, init) =>
					new Promise((_resolve, reject) => {
						const signal = init?.signal
						if (!signal) throw new Error("Expected cancellation signal")
						signals.push(signal)
						signal.addEventListener("abort", () => reject(signal.reason), { once: true })
						if (signals.length === 2) Deferred.doneUnsafe(started, Effect.void)
					})
				const query = make(request).sql(parseStatement("SELECT 1 FORMAT JSON"))
				assert.strictEqual(signals.length, 0)
				const first = yield* Effect.forkChild(query)
				const second = yield* Effect.forkChild(query)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(first)
				assert.isTrue(signals[0]!.aborted)
				assert.isFalse(signals[1]!.aborted)
				yield* Fiber.interrupt(second)
				assert.isTrue(signals[1]!.aborted)
				assert.strictEqual(signals.length, 2)
			}),
		)

		for (const bounded of [false, true]) {
			it.effect(
				`${name} cancels while reading a ${bounded ? "bounded" : "buffered"} response body`,
				() =>
					Effect.gen(function* () {
						const reading = yield* Deferred.make<AbortSignal>()
						let aborted = false
						const request: typeof fetch = async (_input, init) => {
							const signal = init?.signal
							if (!signal) throw new Error("Expected cancellation signal")
							return new Response(
								new ReadableStream({
									start(controller) {
										signal.addEventListener(
											"abort",
											() => {
												aborted = true
												controller.error(signal.reason)
											},
											{ once: true },
										)
									},
									pull() {
										Deferred.doneUnsafe(reading, Effect.succeed(signal))
									},
								}),
							)
						}
						const fiber = yield* Effect.forkChild(
							make(request).sql(
								parseStatement("SELECT 1 FORMAT JSON"),
								bounded ? { responseLimits: { maxBytes: 1024, maxRows: 10 } } : undefined,
							),
						)
						const signal = yield* Deferred.await(reading)
						yield* Fiber.interrupt(fiber)
						assert.isTrue(signal.aborted)
						assert.isTrue(aborted)
					}),
			)
		}

		for (const kind of ["rows", "bytes"] as const) {
			it.effect(`${name} preserves the ${kind} limit error`, () =>
				Effect.gen(function* () {
					const request: typeof fetch = async () =>
						new Response(
							name === "ClickHouse"
								? '{"value":1}\n{"value":2}\n'
								: '{"data":[{"value":1},{"value":2}]}',
						)
					const error = yield* Effect.flip(
						make(request).sql(parseStatement("SELECT 1 FORMAT JSON"), {
							responseLimits: {
								maxBytes: kind === "bytes" ? 1 : 1024,
								maxRows: kind === "rows" ? 1 : 10,
							},
						}),
					)
					assert.instanceOf(error, WarehouseResponseLimitError)
					assert.strictEqual((error as WarehouseResponseLimitError).kind, kind)
				}),
			)
		}
	}

	it.effect("Tinybird inserts are lazy and abort on interruption", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<AbortSignal>()
			let calls = 0
			const request: typeof fetch = (_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal
					if (!signal) throw new Error("Expected cancellation signal")
					calls++
					signal.addEventListener("abort", () => reject(signal.reason), { once: true })
					Deferred.doneUnsafe(started, Effect.succeed(signal))
				})
			const insert = makeTinybirdTestClient(tbConfig, request).insert("traces", [{ id: 1 }])
			assert.strictEqual(calls, 0)
			const fiber = yield* Effect.forkChild(insert)
			const signal = yield* Deferred.await(started)
			yield* Fiber.interrupt(fiber)
			assert.isTrue(signal.aborted)
			assert.strictEqual(calls, 1)
		}),
	)
})

it.effect("the executor's query budget aborts the adapter request without retrying", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<AbortSignal>()
		let attempts = 0
		const request: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal
				if (!signal) throw new Error("Expected cancellation signal")
				attempts++
				signal.addEventListener("abort", () => reject(signal.reason), { once: true })
				Deferred.doneUnsafe(started, Effect.succeed(signal))
			})
		const config = { kind: "tinybird" as const, host: "https://api.tinybird.co", token: "token" }
		const executor = makeWarehouseExecutor({
			createClient: () => __testables.createTinybirdSqlClient(config).pipe(Effect.provide(httpWith(request))),
			resolveRoute: () =>
				Effect.succeed({ source: "managed" as const, config, clientCacheKey: "test" }),
		})
		const fiber = yield* Effect.forkChild(
			Effect.exit(
				executor.compiledQuery(
					makeTenant(),
					scopedSql("SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
					{ profile: "discovery" },
				),
			),
		)
		const signal = yield* Deferred.await(started)
		yield* TestClock.adjust("11 seconds")
		const exit = yield* Fiber.join(fiber)
		assert.isTrue(Exit.isFailure(exit))
		assert.isTrue(signal.aborted)
		assert.strictEqual(attempts, 1)
	}),
)

/** An HttpClient whose transport is the given fetch stand-in. */
const httpWith = (request: typeof fetch) =>
	FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)))

// Driver construction reads its HttpClient from context and touches no network,
// so building a test client synchronously is exact.
const makeClickHouseTestClient = (
	config: Parameters<typeof __testables.createClickHouseSqlClient>[0],
	requestFetch: typeof fetch = fetch,
) => Effect.runSync(__testables.createClickHouseSqlClient(config).pipe(Effect.provide(httpWith(requestFetch))))

const makeTinybirdTestClient = (
	config: Parameters<typeof __testables.createTinybirdSqlClient>[0],
	requestFetch: typeof fetch = fetch,
) => Effect.runSync(__testables.createTinybirdSqlClient(config).pipe(Effect.provide(httpWith(requestFetch))))

/** The Effect HttpClient hands fetch a `Uint8Array` body; decode it for assertions. */
const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""
