// SAFETY-FILE: JSON in this test is emitted by the unit under test (a signed token) before its fields are asserted.
// BOUNDARY-FILE: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { OrgId, UserId, WarehouseDataScopeError, type TenantContext } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { FetchHttpClient } from "effect/http"
import { rawCompiledQuery } from "@maple/query-engine/ch"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { WarehouseQueryService, WarehouseSqlClientFactory } from "./WarehouseQueryService"
import {
	OrgClickHouseSettingsService,
	type OrgClickHouseSettingsServiceApi,
} from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "@maple/backend/services/integrations/TinybirdOrgTokenService"
import { Env } from "@maple/backend/platform/Env"
import { RetentionService } from "@maple/backend/services/retention/RetentionService"
import {
	cleanupTestDbs,
	createTestDb,
	testEdgeCache,
	TestReadHorizonMemoLive,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { CurrentDataScope } from "./data-scope"

// A caller limited to namespaces reads through an org token whose row filters keep every
// datasource to them, or not at all. These drive the service with a recording driver and read the
// filters back out of the token each statement went out with.

const trackedDbs: TestDb[] = []

let clientFactory = WarehouseSqlClientFactory.defaultValue()
const warehouseServiceLayer = Layer.effect(WarehouseQueryService, WarehouseQueryService.make).pipe(
	Layer.provide(Layer.succeed(WarehouseSqlClientFactory, (config) => clientFactory(config))),
)

afterEach(async () => {
	clientFactory = WarehouseSqlClientFactory.defaultValue()
	await cleanupTestDbs(trackedDbs)
})

const GATEWAY = {
	CLICKHOUSE_URL: "https://gateway.tinybird.example",
	CLICKHOUSE_PASSWORD: "gateway-admin-token",
}

const envLayer = (extra: Record<string, string>, signing: boolean) =>
	Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://maple-managed.tinybird.co",
					TINYBIRD_TOKEN: "managed-token",
					...(signing
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
			),
		),
	)

/** The org token service with the retention service whose read horizon it reads, as the app wires them. */
const tokenLayers = <E>(envLive: Layer.Layer<Env, E>, testDb: TestDb) => {
	const retentionLive = RetentionService.layer.pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, testEdgeCache(testDb), TestReadHorizonMemoLive)),
	)
	return Layer.mergeAll(
		retentionLive,
		TinybirdOrgTokenService.layerWithoutDependencies.pipe(
			Layer.provide(Layer.mergeAll(envLive, retentionLive)),
		),
	)
}

const buildLayer = (extra: Record<string, string> = GATEWAY, signing = true) => {
	const envLive = envLayer(extra, signing)
	const testDb = createTestDb(trackedDbs)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
	const orgSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
	)
	return warehouseServiceLayer.pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(envLive, orgSettingsLive, tokenLayers(envLive, testDb))),
	)
}

/** An org that reads from its own ClickHouse. */
const byoLayer = () => {
	const envLive = envLayer({}, true)
	const orgSettingsLive = Layer.succeed(OrgClickHouseSettingsService, {
		resolveRuntimeConfig: () =>
			Effect.succeedSome({
				backend: "clickhouse" as const,
				url: "https://byo.example",
				user: "byo-user",
				password: "byo-password",
				database: "maple",
			}),
		invalidateRuntimeConfig: () => Effect.succeed(false),
	} as OrgClickHouseSettingsServiceApi)
	return warehouseServiceLayer.pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(
			Layer.mergeAll(envLive, orgSettingsLive, tokenLayers(envLive, createTestDb(trackedDbs))),
		),
	)
}

const ORG = Schema.decodeSync(OrgId)("org_test")
const USER = Schema.decodeSync(UserId)("user_test")

const limitedGrants = Policy.grantsOf(
	[Policy.CUSTOM_ROLE_CLERK_KEY],
	Policy.decodeCustomPermissions(Policy.encodePermissions([Policy.SCOPED_READ])),
)

/** A member whose role is limited to `namespaces`; with none given, the list was lost on the way. */
const limitedTenant = (namespaces?: ReadonlyArray<string>): TenantContext => ({
	orgId: ORG,
	userId: USER,
	roles: [],
	permissions: limitedGrants,
	...(namespaces === undefined ? undefined : { namespaces }),
	authMode: "clerk",
})

/** Maple reading on someone's behalf: holds everything. */
const systemTenant: TenantContext = {
	orgId: ORG,
	userId: USER,
	roles: [],
	permissions: Policy.allPermissions,
	authMode: "clerk",
}

const scopedSql = (sql: string, route?: "ingest") =>
	rawCompiledQuery<Record<string, unknown>>({
		sql,
		tenantScope: "single-tenant",
		...(route === undefined ? undefined : { route }),
		reason: "test-fixture",
		justification: "Synthetic SQL asserting routing, not a product query.",
	})

const TokenPayload = Schema.Struct({
	scopes: Schema.Array(Schema.Struct({ resource: Schema.String, filter: Schema.String })),
})
const decodeToken = Schema.decodeUnknownSync(TokenPayload)

/** The datasources a credential may read and the filter on each; `null` when it is not a token. */
const scopesOf = (secret: string): Record<string, string> | null => {
	const body = Str.split(".")(secret)[1]
	if (body === undefined) return null
	const { scopes } = decodeToken(JSON.parse(Buffer.from(body, "base64url").toString("utf8")))
	return Rec.fromEntries(Arr.map(scopes, (scope) => [scope.resource, scope.filter]))
}

interface Sent {
	readonly op: "sql" | "insert"
	readonly kind: string
	readonly sql: string
	readonly secret: string
}

/** Records every statement with the credential it went out on. */
const recordSent = () => {
	const sent: Array<Sent> = []
	clientFactory = (config) => {
		const secret = config.kind === "tinybird" ? config.token : config.password
		return Effect.succeed({
			sql: (statement) =>
				Effect.sync(() => {
					sent.push({ op: "sql", kind: config.kind, sql: statement.text, secret })
					return { data: [] }
				}),
			insert: () =>
				Effect.sync(() => void sent.push({ op: "insert", kind: config.kind, sql: "", secret })),
		})
	}
	return sent
}

const ORG_ONLY = "OrgId = 'org_test'"

const read = (tenant: TenantContext, sql: string, route?: "ingest") =>
	WarehouseQueryService.use((service) => service.compiledQuery(tenant, scopedSql(sql, route)))

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.exit(effect).pipe(
		Effect.map((exit) => {
			const failure = Exit.isFailure(exit)
				? Option.getOrUndefined(Exit.findErrorOption(exit))
				: undefined
			return Schema.is(WarehouseDataScopeError)(failure)
				? failure.message
				: `not refused: ${String(failure)}`
		}),
	)

describe("a read limited to namespaces", () => {
	it.effect("filters a datasource with resource attributes on the namespace it carries", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(
				limitedTenant(["checkout", "payments"]),
				"SELECT 1 FROM traces WHERE OrgId = 'org_test'",
			)
			assert.strictEqual(sent.length, 1)
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				traces: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout', 'payments'))`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("filters a rollup on its namespace column", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(limitedTenant(["checkout"]), "SELECT 1 FROM trace_list_mv WHERE OrgId = 'org_test'")
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				trace_list_mv: `${ORG_ONLY} AND (ServiceNamespace IN ('checkout'))`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})

	// The seek names where a trace's spans live; the spans it leads to are still filtered.
	it.effect("seeks a trace through the trace index, and filters the spans it finds", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(
				limitedTenant(["checkout"]),
				"SELECT 1 FROM traces WHERE OrgId = 'org_test' AND (traces.ServiceName, traces.TraceId) IN (SELECT ServiceName, TraceId FROM trace_index WHERE OrgId = 'org_test')",
			)
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				traces: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
				trace_index: `${ORG_ONLY} AND (1 = 1)`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("reads a statement whose text only mentions another datasource inside a value", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(
				limitedTenant(["checkout"]),
				"SELECT 1 FROM logs WHERE OrgId = 'org_test' AND Body ILIKE '%audit_log%' AND ServiceName = 'session_replays'",
			)
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				logs: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("reads no row when the namespaces were lost on the way to the read", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(limitedTenant(), "SELECT 1 FROM logs WHERE OrgId = 'org_test'")
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), { logs: `${ORG_ONLY} AND (1 = 0)` })
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect(
		"drops a namespace that could not be written into a filter instead of escaping its way out",
		() => {
			const sent = recordSent()
			return Effect.gen(function* () {
				yield* read(
					limitedTenant(["checkout", "a') OR OrgId != ('"]),
					"SELECT 1 FROM logs WHERE OrgId = 'org_test'",
				)
				assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
					logs: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
				})
			}).pipe(Effect.provide(buildLayer()))
		},
	)

	it.effect("filters a control-plane read routed to the write pipeline the same way", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(limitedTenant(["checkout"]), "SELECT 1 FROM logs WHERE OrgId = 'org_test'", "ingest")
			assert.strictEqual(sent[0]?.kind, "tinybird")
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				logs: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})
})

describe("what a read limited to namespaces is refused", () => {
	// A rollup that only names a service is one of them: two namespaces can share a service name,
	// and whoever can send telemetry can claim one.
	it.effect("a datasource whose rows carry no namespace, before anything is sent", () => {
		const sent = recordSent()
		const datasources = [
			"session_replay_events",
			"service_map_edges_hourly",
			"alert_checks",
			"error_events",
			"metric_catalog",
			"service_usage",
			"traces_aggregates_hourly",
		]
		return Effect.gen(function* () {
			const messages = yield* Effect.forEach(datasources, (datasource) =>
				refusal(
					read(limitedTenant(["checkout"]), `SELECT 1 FROM ${datasource} WHERE OrgId = 'org_test'`),
				),
			)
			assert.deepStrictEqual(
				Arr.map(messages, (message, index) =>
					Str.includes(`${datasources[index]} cannot be limited`)(message),
				),
				Arr.map(datasources, () => true),
			)
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("a statement that joins a filtered datasource to one that cannot be", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const message = yield* refusal(
				read(
					limitedTenant(["checkout"]),
					"SELECT 1 FROM traces JOIN session_replays USING (TraceId) WHERE OrgId = 'org_test'",
				),
			)
			assert.include(message, "session_replays")
			assert.notInclude(message, "traces,")
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("a read declared to span organizations", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const message = yield* refusal(
				WarehouseQueryService.use((service) =>
					service.crossOrgQuery(
						limitedTenant(["checkout"]),
						rawCompiledQuery<Record<string, unknown>>({
							sql: "SELECT OrgId FROM traces GROUP BY OrgId",
							tenantScope: "cross-tenant",
							reason: "test-fixture",
							justification: "Synthetic SQL asserting routing, not a product query.",
						}),
						{ justification: "test" },
					),
				),
			)
			assert.include(message, "across organizations")
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("every read of an organization on its own ClickHouse", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const compiled = yield* refusal(
				read(limitedTenant(["checkout"]), "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			)
			const raw = yield* refusal(
				WarehouseQueryService.use((service) =>
					service.rawSqlQuery(
						limitedTenant(["checkout"]),
						"SELECT 1 FROM traces WHERE OrgId = 'org_test'",
					),
				),
			)
			assert.include(compiled, "own ClickHouse")
			assert.include(raw, "own ClickHouse")
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(byoLayer()))
	})

	it.effect("every read where the managed warehouse is a vanilla ClickHouse", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const message = yield* refusal(
				read(limitedTenant(["checkout"]), "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			)
			assert.include(message, "cannot enforce")
			assert.deepStrictEqual(sent, [])
		}).pipe(
			Effect.provide(
				buildLayer(
					{
						CLICKHOUSE_URL: "https://clickhouse.example",
						CLICKHOUSE_PROVIDER: "clickhouse",
						CLICKHOUSE_PASSWORD: "vanilla-password",
					},
					false,
				),
			),
		)
	})

	it.effect("every read where no signing key can mint its token", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const message = yield* refusal(
				read(limitedTenant(["checkout"]), "SELECT 1 FROM traces WHERE OrgId = 'org_test'"),
			)
			assert.include(message, "cannot enforce")
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(buildLayer(GATEWAY, false)))
	})
})

describe("caller SQL limited to namespaces", () => {
	it.effect("runs on a token that lists only datasources it can filter by namespace, each filtered", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.rawSqlQuery(
					limitedTenant(["checkout"]),
					"SELECT 1 FROM whatever WHERE OrgId = 'org_test'",
				),
			)
			const scopes = scopesOf(sent[0]?.secret ?? "") ?? {}
			assert.isAbove(Rec.keys(scopes).length, 10)
			const unfiltered = Arr.filter(
				Rec.toEntries(scopes),
				([, filter]) =>
					!Str.includes("IN ('checkout')")(filter) || !Str.startsWith(`${ORG_ONLY} AND (`)(filter),
			)
			assert.deepStrictEqual(unfiltered, [])
			assert.strictEqual(
				scopes.traces,
				`${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
			)
			// Not the trace index either: caller SQL could select its rows.
			for (const datasource of ["trace_index", "error_events", "session_replay_events", "audit_log"]) {
				assert.isUndefined(scopes[datasource], datasource)
			}
		}).pipe(Effect.provide(buildLayer()))
	})
})

describe("the request's data scope", () => {
	const checkout: Policy.DataScope = { _tag: "Namespaces", namespaces: ["checkout"] }

	it.effect("limits a read made as a system tenant on a limited caller's behalf", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(systemTenant, "SELECT 1 FROM traces WHERE OrgId = 'org_test'").pipe(
				Effect.provideService(CurrentDataScope, checkout),
			)
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				traces: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("refuses that system tenant what the caller could not read", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const message = yield* refusal(
				read(systemTenant, "SELECT 1 FROM alert_checks WHERE OrgId = 'org_test'", "ingest").pipe(
					Effect.provideService(CurrentDataScope, checkout),
				),
			)
			assert.include(message, "alert_checks")
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("narrows with the tenant's own namespaces: a namespace must be in both", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(
				limitedTenant(["payments", "checkout"]),
				"SELECT 1 FROM logs WHERE OrgId = 'org_test'",
			).pipe(
				Effect.provideService(CurrentDataScope, {
					_tag: "Namespaces",
					namespaces: ["checkout", "search"],
				}),
			)
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), {
				logs: `${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
			})
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("leaves an unlimited caller on the org's own token", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* read(systemTenant, "SELECT 1 FROM session_replay_events WHERE OrgId = 'org_test'")
			assert.deepStrictEqual(scopesOf(sent[0]?.secret ?? ""), { session_replay_events: ORG_ONLY })
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("still lets a limited request write: a write reads no row", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			yield* WarehouseQueryService.use((service) =>
				service.ingest(systemTenant, "audit_log", [{ OrgId: "org_test" }]),
			).pipe(Effect.provideService(CurrentDataScope, checkout))
			assert.deepStrictEqual(
				Arr.map(sent, (entry) => [entry.op, entry.secret]),
				[["insert", "managed-token"]],
			)
		}).pipe(Effect.provide(buildLayer()))
	})

	it.effect("never hands a limited read the client an unlimited read of the same org opened", () => {
		const sent = recordSent()
		return Effect.gen(function* () {
			const sql = "SELECT 1 FROM traces WHERE OrgId = 'org_test'"
			yield* read(systemTenant, sql)
			yield* read(limitedTenant(["checkout"]), sql)
			yield* read(limitedTenant(["search"]), sql)
			yield* read(systemTenant, sql)
			assert.deepStrictEqual(
				Arr.map(sent, (entry) => scopesOf(entry.secret)?.traces),
				[
					ORG_ONLY,
					`${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('checkout'))`,
					`${ORG_ONLY} AND (ResourceAttributes['service.namespace'] IN ('search'))`,
					ORG_ONLY,
				],
			)
		}).pipe(Effect.provide(buildLayer()))
	})
})
