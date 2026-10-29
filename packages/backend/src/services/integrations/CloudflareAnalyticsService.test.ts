import { IntegrationsValidationError } from "@maple/domain/http"
// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { randomUUID } from "node:crypto"
import { Retry } from "@distilled.cloud/cloudflare"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { clickHouseSchemaVersion } from "@maple/domain/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	CloudflareAnalyticsState,
	type CloudflareAnalyticsStateInsert,
	CloudflareHyperdriveConfigs,
	CloudflareZoneSettings,
	OAuthConnections,
	OrgClickHouseSettings,
} from "@maple/db/tables"
import { Array as Arr, ConfigProvider, Effect, Layer, Metric, Schema, Tracer } from "effect"
import type { Types } from "effect"
import * as CloudflareAnalyticsMetrics from "@maple/backend/observability/CloudflareAnalyticsMetrics"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { createIntegrationSource, publicSourceId } from "@maple/backend/services/org/integration-sources"
import { SourceId } from "@maple/domain/primitives"
import { CloudflareAnalyticsService, hasAnalyticsScopes } from "./CloudflareAnalyticsService"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import type { MetricGaugeRow, MetricSumRow } from "./cloudflare-analytics/mapping"
import type { OtlpMetricsPayload } from "./cloudflare-analytics/otlp"
import { compiledQueryOf } from "@maple/query-engine/execution"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_cf")
const ACCOUNT_ID = "acct-1"
const ZONE_ID = "zone-1"
const ZONE_NAME = "example.com"

/** Fixed test wall-clock: 2026-07-02T12:00:00Z. */
const T0 = Date.parse("2026-07-02T12:00:00Z")
const MIN = 60_000

const ANALYTICS_SCOPE =
	"account-settings.read account-analytics.read analytics.read zone.read workers-scripts.read"

const ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString("base64")

const baseConfig = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client-id",
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const BUCKET = "2026-07-02T11:35:00Z"

const zoneFixture = {
	id: ZONE_ID,
	name: ZONE_NAME,
	status: "active",
	account: { id: ACCOUNT_ID, name: "Test Account" },
	activated_on: "2025-01-01T00:00:00Z",
	created_on: "2025-01-01T00:00:00Z",
	development_mode: 0,
	meta: {},
	modified_on: "2025-01-01T00:00:00Z",
	name_servers: ["ns1.example.com"],
	original_dnshost: null,
	original_name_servers: null,
	original_registrar: null,
	owner: { id: null, name: null, type: null },
	plan: { id: "free", name: "Free" },
	paused: false,
	type: "full",
}

const settingsData = {
	viewer: {
		zones: [
			{
				zoneTag: ZONE_ID,
				settings: {
					httpRequestsAdaptiveGroups: {
						enabled: true,
						// 2h retention keeps the first-poll backfill to a couple of windows.
						notOlderThan: 7200,
						maxDuration: 3600,
						availableFields: ["edgeTimeToFirstByteMsP50", "count"],
					},
				},
			},
		],
		accounts: [
			{
				settings: {
					workersInvocationsAdaptive: {
						enabled: true,
						notOlderThan: 7200,
						maxDuration: 3600,
						availableFields: ["cpuTimeP50", "requests"],
					},
				},
			},
		],
	},
}

const httpData = {
	viewer: {
		zones: [
			{
				zoneTag: ZONE_ID,
				groups: [
					{
						count: 10,
						avg: { sampleInterval: 10 },
						sum: { edgeResponseBytes: 5000, visits: 8 },
						dimensions: {
							datetimeFiveMinutes: BUCKET,
							cacheStatus: "hit",
							edgeResponseStatus: 200,
						},
					},
				],
				latency: [
					{
						count: 10,
						quantiles: {
							edgeTimeToFirstByteMsP50: 42,
							edgeTimeToFirstByteMsP95: 180,
							edgeTimeToFirstByteMsP99: 400,
							originResponseDurationMsP50: 12,
							originResponseDurationMsP95: 90,
							originResponseDurationMsP99: 300,
						},
						dimensions: { datetimeFiveMinutes: BUCKET },
					},
				],
			},
		],
	},
}

const workersData = {
	viewer: {
		accounts: [
			{
				invocations: [
					{
						sum: { requests: 42, errors: 2, subrequests: 5 },
						quantiles: {
							cpuTimeP50: 1500,
							cpuTimeP99: 9000,
							durationP50: 0.002,
							durationP99: 0.05,
						},
						dimensions: {
							datetimeFiveMinutes: BUCKET,
							scriptName: "my-worker",
							status: "success",
						},
					},
				],
			},
		],
	},
}

interface OtlpCall {
	readonly authorization: string
	readonly payload: OtlpMetricsPayload
}

/** Wire-form Hyperdrive config as `GET /accounts/{id}/hyperdrive/configs` returns it. */
interface HyperdriveConfigFixture {
	readonly id: string
	readonly name: string
	readonly origin: Record<string, unknown>
}

interface FetchOptions {
	readonly zones?: ReadonlyArray<typeof zoneFixture>
	/**
	 * When set, the `/zones` listing serves only the zones of the account whose id appears
	 * in the request URL (the listing is account-filtered upstream) — multi-account tests.
	 */
	readonly zonesByAccount?: Record<string, ReadonlyArray<typeof zoneFixture>>
	readonly zonesStatus?: number
	readonly graphqlErrors?: ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }>
	/** When set, every outbound GraphQL document is captured here (batching assertions). */
	readonly graphqlQueries?: Array<string>
	/** When set, the `$zoneTags` of every outbound GraphQL document are captured here. */
	readonly graphqlZoneTags?: Array<ReadonlyArray<string>>
	/** Live Worker scripts the REST enumeration returns (default: my-worker). */
	readonly workerScripts?: ReadonlyArray<{ id: string }>
	/** Hyperdrive configs the REST enumeration returns (default: none). Mutable so a test can change the upstream set between polls. */
	/** Serve this many synthetic active zones with real pagination (50/page). */
	zonesTotal?: number
	/** Awaited before answering each GraphQL call — lets a test interleave a concurrent write. */
	onGraphql?: () => Promise<void>
	hyperdriveConfigs?: ReadonlyArray<HyperdriveConfigFixture>
	/** HTTP status for the hyperdrive listing (default 200). Mutable for per-poll failure injection. */
	hyperdriveStatus?: number
	/** When set, OTLP metrics POSTs to the ingest gateway (`/v1/metrics`) are captured here. */
	readonly otlpCalls?: Array<OtlpCall>
	/** HTTP status the mock gateway returns for `/v1/metrics` (default 200). */
	readonly metricsStatus?: number
	/** Raw `/v1/metrics` response body served as HTML with a `cf-ray` header (an edge block page). */
	readonly metricsHtml?: string
}

/** Read the outbound request body regardless of how the HttpClient encodes it (string/bytes/stream). */
const readRequestBody = async (
	input: Parameters<typeof globalThis.fetch>[0],
	init?: RequestInit,
): Promise<string> => {
	if (init?.body != null) {
		if (typeof init.body === "string") return init.body
		return await new Response(init.body as BodyInit).text()
	}
	return input instanceof Request ? await input.text() : "{}"
}

/** A tracer that keeps every span, so a test can read what the poller annotated. */
const recordSpans = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	const named = (name: string) => spans.filter((span) => span.name === name)
	return { tracer, named }
}

/** Read an outbound request header regardless of whether it's on the Request or the init. */
const readHeader = (
	input: Parameters<typeof globalThis.fetch>[0],
	init: RequestInit | undefined,
	name: string,
): string => {
	if (init?.headers) {
		const value = new Headers(init.headers as HeadersInit).get(name)
		if (value != null) return value
	}
	if (input instanceof Request) {
		const value = input.headers.get(name)
		if (value != null) return value
	}
	return ""
}

const mockCloudflareFetch =
	(options: FetchOptions = {}): typeof globalThis.fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.includes("/v1/metrics")) {
			options.otlpCalls?.push({
				authorization: readHeader(input, init, "authorization"),
				payload: JSON.parse(await readRequestBody(input, init)) as OtlpMetricsPayload,
			})
			if (options.metricsHtml !== undefined) {
				return new Response(options.metricsHtml, {
					status: options.metricsStatus ?? 200,
					headers: { "content-type": "text/html", "cf-ray": "8d1f2e3a4b5c6d7e-FRA" },
				})
			}
			return jsonResponse({}, options.metricsStatus ?? 200)
		}
		if (url.includes("/graphql")) {
			await options.onGraphql?.()
			const body = JSON.parse(await readRequestBody(input, init)) as {
				query: string
				variables?: { zoneTags?: ReadonlyArray<string> }
			}
			options.graphqlQueries?.push(body.query)
			options.graphqlZoneTags?.push(body.variables?.zoneTags ?? [])
			if (options.graphqlErrors) {
				return jsonResponse({ data: null, errors: options.graphqlErrors })
			}
			if (body.query.includes("MapleCfDatasetSettings")) return jsonResponse({ data: settingsData })
			if (body.query.includes("MapleCfZoneAnalytics")) return jsonResponse({ data: httpData })
			if (body.query.includes("MapleCfAccountAnalytics")) return jsonResponse({ data: workersData })
			return jsonResponse({ data: null, errors: [{ message: "unknown query" }] })
		}
		if (url.includes("/hyperdrive/configs")) {
			if (options.hyperdriveStatus) {
				return jsonResponse(
					{
						success: false,
						errors: [{ code: 10000, message: "Authentication error" }],
						messages: [],
						result: null,
					},
					options.hyperdriveStatus,
				)
			}
			const page = Number(new URL(url).searchParams.get("page") ?? "1")
			const configs = page === 1 ? (options.hyperdriveConfigs ?? []) : []
			return jsonResponse({
				success: true,
				errors: [],
				messages: [],
				result: configs,
				result_info: {
					count: configs.length,
					page,
					per_page: 50,
					total_count: options.hyperdriveConfigs?.length ?? 0,
				},
			})
		}
		if (url.includes("/workers/scripts")) {
			const page = Number(new URL(url).searchParams.get("page") ?? "1")
			const scripts = page === 1 ? (options.workerScripts ?? [{ id: "my-worker" }]) : []
			return jsonResponse({
				success: true,
				errors: [],
				messages: [],
				result: scripts,
				result_info: { count: scripts.length, page, per_page: 100, total_count: scripts.length },
			})
		}
		if (url.includes("/zones")) {
			if (options.zonesStatus) {
				return jsonResponse(
					{
						success: false,
						errors: [{ code: 10000, message: "Authentication error" }],
						messages: [],
						result: null,
					},
					options.zonesStatus,
				)
			}
			const page = Number(new URL(url).searchParams.get("page") ?? "1")
			if (options.zonesTotal != null) {
				const perPage = 50
				const start = (page - 1) * perPage
				const count = Math.min(perPage, Math.max(0, options.zonesTotal - start))
				const synthetic = Array.from({ length: count }, (_, index) => ({
					...zoneFixture,
					id: `zone-${start + index}`,
					name: `z${start + index}.example.com`,
				}))
				return jsonResponse({
					success: true,
					errors: [],
					messages: [],
					result: synthetic,
					result_info: { count, page, per_page: perPage, total_count: options.zonesTotal },
				})
			}
			const forAccount =
				options.zonesByAccount == null
					? null
					: (Object.entries(options.zonesByAccount).find(([accountId]) =>
							url.includes(accountId),
						)?.[1] ?? [])
			const zones = page === 1 ? (forAccount ?? options.zones ?? [zoneFixture]) : []
			return jsonResponse({
				success: true,
				errors: [],
				messages: [],
				result: zones,
				result_info: { count: zones.length, page, per_page: 50, total_count: zones.length },
			})
		}
		return jsonResponse({ success: false, errors: [], messages: [], result: null }, 404)
	}

interface CapturedIngest {
	datasource: string
	orgId: string
	rows: Array<MetricSumRow | MetricGaugeRow>
}

interface CompiledQueryStub {
	rows: ReadonlyArray<Record<string, unknown>>
	/** Rows served to the `cloudflareUsageStats` companion query (defaults to none). */
	statsRows?: ReadonlyArray<Record<string, unknown>>
	calls: Array<{
		sql: string
		orgId: string
		options: { route?: "ingest"; profile?: string; context?: string } | undefined
	}>
}

const makeWarehouseStub = (
	captured: CapturedIngest[],
	queryStub?: CompiledQueryStub,
): WarehouseQueryServiceApi =>
	({
		ingest: (
			tenant: { orgId: string },
			datasource: string,
			rows: ReadonlyArray<MetricSumRow | MetricGaugeRow>,
		) =>
			Effect.sync(() => {
				captured.push({ datasource, orgId: tenant.orgId, rows: [...rows] })
			}),
		compiledQuery: (
			tenant: { orgId: string },
			compiled: {
				sql: string
				decodeRows: (
					rows: ReadonlyArray<Record<string, unknown>>,
				) => Effect.Effect<ReadonlyArray<unknown>, unknown>
			},
			options?: CompiledQueryStub["calls"][number]["options"],
		) =>
			// Mirror the real executor: run the compiled query's `decodeRows` so a
			// query's row schema (the `CHNumber` coercion it derives from the SELECT)
			// is actually exercised instead of passing raw stub rows straight through.
			Effect.sync(() => {
				queryStub?.calls.push({ sql: compiledQueryOf(compiled).sql, orgId: tenant.orgId, options })
			}).pipe(
				Effect.flatMap(() =>
					compiledQueryOf(compiled).decodeRows(
						(options?.context === "cloudflareUsageStats"
							? queryStub?.statsRows
							: queryStub?.rows) ?? [],
					),
				),
				Effect.orDie,
			),
	}) as WarehouseQueryServiceApi

const makeLayer = (
	testDb: TestDb,
	captured: CapturedIngest[],
	fetchOptions: FetchOptions = {},
	configOverrides: Record<string, string> = {},
	queryStub?: CompiledQueryStub,
) =>
	Layer.effect(CloudflareAnalyticsService, CloudflareAnalyticsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provideMerge(CloudflareOAuthService.layer),
		Layer.provideMerge(OrgIngestKeysService.layer),
		Layer.provideMerge(
			OrgClickHouseSettingsService.layer.pipe(
				Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))),
			),
		),
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseStub(captured, queryStub))),
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provideMerge(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...configOverrides })),
		),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mockCloudflareFetch(fetchOptions))),
		Layer.provideMerge(Layer.succeed(Retry.Retry, { while: () => false })),
	)

/**
 * Insert the org's Cloudflare connection with a non-expiring encrypted access token. One grant
 * may cover several accounts — pass them all; the first is the row's principal.
 */
const seedConnection = (
	scope: string = ANALYTICS_SCOPE,
	accounts: Arr.NonEmptyReadonlyArray<{ id: string; name: string }> = [
		{ id: ACCOUNT_ID, name: "Test Account" },
	],
) =>
	Effect.gen(function* () {
		const database = yield* Database
		const key = yield* parseBase64Aes256GcmKey(
			ENCRYPTION_KEY_B64,
			(message) => new IntegrationsValidationError({ message }),
		)
		const accessEnc = yield* encryptAes256Gcm(
			"cf-access-token",
			key,
			(message) => new IntegrationsValidationError({ message }),
		)
		const id = randomUUID()
		yield* database.execute((db) =>
			Effect.gen(function* () {
				const sourceId = yield* createIntegrationSource(
					db,
					ORG,
					{ platform: "cloudflare", name: Arr.headNonEmpty(accounts).name },
					T0 - 60 * MIN,
				)
				yield* db.run(
					PG.insertInto(OAuthConnections).values({
						id,
						orgId: ORG,
						sourceId,
						provider: "cloudflare",
						externalUserId: Arr.headNonEmpty(accounts).id,
						externalAccountName: Arr.headNonEmpty(accounts).name,
						grantedAccountsJson:
							accounts.length > 1
								? JSON.stringify(
										accounts.map((account) => ({ id: account.id, name: account.name })),
									)
								: null,
						connectedByUserId: Schema.decodeUnknownSync(UserId)("user_1"),
						scope,
						accessTokenCiphertext: accessEnc.ciphertext,
						accessTokenIv: accessEnc.iv,
						accessTokenTag: accessEnc.tag,
						expiresAt: null,
						createdAt: T0 - 60 * MIN,
						updatedAt: T0 - 60 * MIN,
					}),
				)
			}),
		)
	})

/**
 * Insert a BYO-ClickHouse settings row for ORG. `schemaVersion` defaults to the
 * running `clickHouseSchemaVersion` and `syncStatus` to "connected" — i.e. a
 * write-ready org whose gateway-written metrics land in its own CH. Override
 * either to simulate schema drift / a disconnected cluster.
 */
const seedByoClickHouse = (overrides: { syncStatus?: string; schemaVersion?: string | null } = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(OrgClickHouseSettings).values({
					orgId: ORG,
					chUrl: "https://ch.example.com",
					chUser: "default",
					chDatabase: "maple",
					syncStatus: overrides.syncStatus ?? "connected",
					schemaVersion:
						overrides.schemaVersion === undefined
							? clickHouseSchemaVersion
							: overrides.schemaVersion,
					createdAt: T0 - 60 * MIN,
					updatedAt: T0 - 60 * MIN,
					createdBy: "user_1",
					updatedBy: "user_1",
				}),
			),
		)
	})

const seedStateRow = (values: Partial<CloudflareAnalyticsStateInsert> & { dataset: string }) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(CloudflareAnalyticsState).values({
					id: randomUUID(),
					orgId: ORG,
					accountId: ACCOUNT_ID,
					zoneId: "",
					createdAt: T0 - 60 * MIN,
					updatedAt: T0 - 60 * MIN,
					...values,
				}),
			),
		)
	})

const loadStateRows = Effect.gen(function* () {
	const database = yield* Database
	return yield* database.execute((db) => db.run(PG.from(CloudflareAnalyticsState).select()))
})

/** Pin the org's adaptive call cap on its existing workers anchor rows. */
const seedGrantCap = (cap: number) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.update(CloudflareAnalyticsState)
					.set({ grantCallCap: cap })
					.where(($) => [$.dataset.eq("workers_invocations"), $.zoneId.eq("")]),
			),
		)
	})

const grantCapsOf = loadStateRows.pipe(
	Effect.map((rows) =>
		rows
			.filter((row) => row.dataset === "workers_invocations" && row.zoneId === "")
			.map((row) => row.grantCallCap),
	),
)

interface FlatMetric {
	readonly name: string
	readonly value: number
	readonly serviceName: string
	readonly kind: "sum" | "gauge"
}

/** Flatten captured OTLP payloads into per-datapoint facts for assertions. */
const flattenOtlp = (calls: ReadonlyArray<OtlpCall>): FlatMetric[] => {
	const out: FlatMetric[] = []
	for (const call of calls) {
		for (const rm of call.payload.resourceMetrics) {
			const serviceName =
				rm.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue ?? ""
			for (const sm of rm.scopeMetrics) {
				for (const metric of sm.metrics) {
					const kind = metric.sum ? "sum" : "gauge"
					const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []
					for (const dp of dataPoints) {
						out.push({ name: metric.name, value: dp.asDouble, serviceName, kind })
					}
				}
			}
		}
	}
	return out
}

describe("hasAnalyticsScopes", () => {
	it("requires every analytics scope", () => {
		assert.isTrue(hasAnalyticsScopes(ANALYTICS_SCOPE))
		assert.isFalse(hasAnalyticsScopes("account-settings.read workers-scripts.read"))
		assert.isFalse(hasAnalyticsScopes(""))
	})

	it("is not satisfied by zone.read alone — zone analytics needs analytics.read", () => {
		// Regression: zone.read lists zones but does NOT authorize httpRequestsAdaptiveGroups, so a
		// token with account+zone read but no analytics.read polled workers fine while every zone
		// query was rejected "not authorized". Such a token must read as not analytics-capable.
		assert.isFalse(hasAnalyticsScopes("account-analytics.read zone.read"))
		assert.isTrue(hasAnalyticsScopes("account-analytics.read analytics.read zone.read"))
	})
})

describe("CloudflareAnalyticsService", () => {
	it.effect("pollOrg skips when Cloudflare is not connected", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.skipped, "not connected")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg skips a scope-incapable account without calling the API or touching state", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection("account-settings.read workers-scripts.read")
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.skipped, "missing analytics scopes")
			assert.strictEqual(summary.callsMade, 0)
			// The account is skipped before any state rows exist — capability is surfaced
			// per account by the status endpoint (analyticsCapable), not by error stamps
			// rewritten every tick.
			const rows = yield* loadStateRows
			assert.strictEqual(rows.length, 0)
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg reads nothing while the source is paused and resumes from now", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const ingested = captured.length
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE sources SET paused_at = now() WHERE platform = 'cloudflare'", []),
			)
			yield* TestClock.adjust("1 hour")

			const summary = yield* service.pollOrg(ORG)
			assert.deepStrictEqual([summary.skipped, summary.callsMade], ["source paused", 0])
			assert.strictEqual(captured.length, ingested)
			// The paused hour is never read: the head moved to the new horizon, floor(now - 10min, 5min).
			const horizon = Date.parse("2026-07-02T12:50:00Z")
			assert.isTrue((yield* loadStateRows).every((row) => row.watermarkAt === horizon))
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg discovers zones, emits metrics to the gateway, and advances watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isNull(summary.skipped)
			assert.isAbove(summary.callsMade, 0)
			assert.isAbove(summary.rowsIngested, 0)

			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			const workersRow = rows.find((row) => row.dataset === "workers_invocations")
			assert.isDefined(httpRow)
			assert.isDefined(workersRow)
			assert.strictEqual(httpRow!.zoneId, ZONE_ID)
			assert.strictEqual(httpRow!.zoneName, ZONE_NAME)
			assert.isTrue(httpRow!.enabled)
			assert.isNull(httpRow!.lastError)
			// Head caught up to the safety-lag horizon: watermark = floor(now - 10min, 5min) = 11:50.
			const horizon = Date.parse("2026-07-02T11:50:00Z")
			assert.strictEqual(httpRow!.watermarkAt, horizon)
			assert.strictEqual(workersRow!.watermarkAt, horizon)
			// The backfill frontier filled in behind the head and, under the plan's 2h retention,
			// reached its floor (floor(now-2h)+1bucket = 10:05) within the same tick.
			const retentionFloor = Date.parse("2026-07-02T10:05:00Z")
			assert.strictEqual(httpRow!.backfillAt, retentionFloor)
			assert.strictEqual(workersRow!.backfillAt, retentionFloor)
			// Settings were interrogated and cached.
			assert.include(httpRow!.settingsJson ?? "", "notOlderThan")
			// Lease released after the tick.
			assert.isNull(workersRow!.leaseUntil)

			const metrics = flattenOtlp(otlpCalls)
			const requests = metrics.find((m) => m.name === "cloudflare.http.requests")
			assert.isDefined(requests)
			assert.strictEqual(requests!.value, 100) // count 10 × sampleInterval 10
			assert.strictEqual(requests!.serviceName, `cloudflare/${ZONE_NAME}`)
			const workerRequests = metrics.find((m) => m.name === "cloudflare.worker.requests")
			assert.strictEqual(workerRequests!.value, 42)

			assert.isDefined(
				metrics.find((m) => m.name === "cloudflare.http.edge.ttfb" && m.kind === "gauge"),
			)
			assert.isDefined(
				metrics.find((m) => m.name === "cloudflare.worker.cpu_time" && m.kind === "gauge"),
			)
			// Every gateway POST is authenticated with the org's public ingest key (which routes
			// the org to its own warehouse — managed Tinybird or BYO ClickHouse).
			assert.isAbove(otlpCalls.length, 0)
			assert.isTrue(otlpCalls.every((call) => call.authorization.startsWith("Bearer maple_pk_")))
			// Every resource names the grant's pull source.
			const source = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(testDb, "SELECT id FROM sources WHERE platform = 'cloudflare'"),
			)
			const expectedSource = publicSourceId(Schema.decodeUnknownSync(SourceId)(source!.id))
			const stamped = otlpCalls.flatMap((call) =>
				call.payload.resourceMetrics.map(
					(rm) =>
						rm.resource.attributes.find((a) => a.key === "maple_source_id")?.value.stringValue,
				),
			)
			assert.deepStrictEqual(
				stamped,
				stamped.map(() => expectedSource),
			)
			// Nothing bypassed the gateway via a direct warehouse ingest.
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls })))
	})

	it.effect("each chunk span names its datasets, zones, window and outcome", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const { tracer, named } = recordSpans()
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// A small cap so the first tick ends with history still owed.
			yield* seedStateRow({ dataset: "workers_invocations", grantCallCap: 20 })
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG).pipe(Effect.withTracer(tracer))

			const chunks = named("CloudflareAnalyticsService.pollDatasetChunk")
			const httpHead = chunks.find(
				(span) =>
					span.attributes.get("maple.cloudflare.scope") === "zone" &&
					span.attributes.get("maple.cloudflare.phase") === "head",
			)
			assert.isDefined(httpHead)
			const attr = (key: string) => httpHead!.attributes.get(key)
			assert.include(String(attr("maple.cloudflare.datasets")).split(","), "http_requests")
			assert.strictEqual(attr("maple.cloudflare.zones"), ZONE_NAME)
			assert.strictEqual(attr("maple.cloudflare.zone_count"), 1)
			assert.strictEqual(attr("maple.cloudflare.account_id"), ACCOUNT_ID)
			assert.strictEqual(attr("maple.cloudflare.window.end"), "2026-07-02T11:50:00Z")
			assert.strictEqual(attr("maple.cloudflare.window.lag_ms"), 10 * MIN)
			assert.strictEqual(attr("maple.cloudflare.outcome"), "advanced")
			assert.isAbove(Number(attr("maple.cloudflare.rows_ingested")), 0)

			// The first tick runs out of budget with history still owed; later ticks drain it.
			const [first] = named("CloudflareAnalyticsService.pollConnection")
			assert.strictEqual(first!.attributes.get("maple.cloudflare.stop_reason"), "budget_exhausted")
			assert.isAbove(Number(first!.attributes.get("maple.cloudflare.pending_items")), 0)
			yield* service.pollOrg(ORG)
			const next = recordSpans()
			yield* service.pollOrg(ORG).pipe(Effect.withTracer(next.tracer))
			const [poll] = next.named("CloudflareAnalyticsService.pollConnection")
			assert.strictEqual(poll!.attributes.get("maple.cloudflare.stop_reason"), "caught_up")
			assert.strictEqual(poll!.attributes.get("maple.cloudflare.pending_items"), 0)
			// Caught up means the head sits at the safety horizon, 10 min behind now.
			assert.strictEqual(poll!.attributes.get("maple.cloudflare.max_lag_ms"), 10 * MIN)

			const lag = yield* Metric.value(
				Metric.withAttributes(CloudflareAnalyticsMetrics.datasetLagSeconds, {
					org_id: ORG,
					account_id: ACCOUNT_ID,
					dataset: "http_requests",
				}),
			)
			assert.strictEqual(lag.value, 600)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg polls every account of the grant, each with its own state rows and zones", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const SECOND_ACCOUNT = "acct-2"
		const secondZone = {
			...zoneFixture,
			id: "zone-2",
			name: "beta.example",
			account: { id: SECOND_ACCOUNT, name: "Second Account" },
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			// One grant covering both accounts — the order here is the status order.
			yield* seedConnection(ANALYTICS_SCOPE, [
				{ id: ACCOUNT_ID, name: "Test Account" },
				{ id: SECOND_ACCOUNT, name: "Second Account" },
			])
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isNull(summary.skipped)
			assert.isAbove(summary.rowsIngested, 0)

			// Each account discovered ITS zones and owns its state rows — including its own
			// workers anchor, so leases and discovery run per account.
			const rows = yield* loadStateRows
			const httpRows = rows.filter((row) => row.dataset === "http_requests")
			assert.deepStrictEqual(httpRows.map((row) => `${row.accountId}:${row.zoneId}`).sort(), [
				`${ACCOUNT_ID}:${ZONE_ID}`,
				`${SECOND_ACCOUNT}:zone-2`,
			])
			const anchors = rows.filter((row) => row.dataset === "workers_invocations")
			assert.deepStrictEqual(anchors.map((row) => row.accountId).sort(), [ACCOUNT_ID, SECOND_ACCOUNT])

			// The integration status breaks the same state down per account, while the
			// legacy top-level view merges both accounts' zones.
			const status = yield* service.getIntegrationStatus(ORG)
			assert.strictEqual(status.connected, true)
			assert.deepStrictEqual(
				(status.accounts ?? []).map((account) => account.accountId),
				[ACCOUNT_ID, SECOND_ACCOUNT],
			)
			assert.deepStrictEqual(
				(status.accounts ?? []).map((account) => account.zones.map((zone) => zone.id)),
				[[ZONE_ID], ["zone-2"]],
			)
			assert.deepStrictEqual(status.zones.map((zone) => zone.id).sort(), [ZONE_ID, "zone-2"].sort())
			assert.strictEqual(status.accountId, ACCOUNT_ID)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					zonesByAccount: { [ACCOUNT_ID]: [zoneFixture], [SECOND_ACCOUNT]: [secondZone] },
				}),
			),
		)
	})

	const hyperdriveMysqlFixture: HyperdriveConfigFixture = {
		id: "a".repeat(32),
		name: "maple-mysql",
		origin: {
			database: "maple",
			host: "aws.connect.psdb.cloud",
			port: 3306,
			scheme: "mysql",
			user: "reader",
		},
	}
	// VPC-service origin variant: no host/port on the wire.
	const hyperdriveVpcFixture: HyperdriveConfigFixture = {
		id: "b".repeat(32),
		name: "maple-pg",
		origin: {
			database: "pgdb",
			scheme: "postgres",
			service_id: "svc-1",
			user: "writer",
		},
	}

	it.effect(
		"pollOrg discovers hyperdrive configs, reconciles renames, and soft-deletes vanished configs",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			const fetchOptions: FetchOptions = {
				hyperdriveConfigs: [hyperdriveMysqlFixture, hyperdriveVpcFixture],
			}
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				const service = yield* CloudflareAnalyticsService

				yield* service.pollOrg(ORG)
				const first = yield* service.listHyperdriveConfigs(ORG)
				assert.strictEqual(first.length, 2)
				const mysqlRow = first.find((row) => row.configId === hyperdriveMysqlFixture.id)
				assert.strictEqual(mysqlRow?.name, "maple-mysql")
				assert.strictEqual(mysqlRow?.originHost, "aws.connect.psdb.cloud")
				assert.strictEqual(mysqlRow?.originPort, 3306)
				assert.strictEqual(mysqlRow?.originDatabase, "maple")
				// The VPC variant normalizes its absent host/port to null.
				const vpcRow = first.find((row) => row.configId === hyperdriveVpcFixture.id)
				assert.isNull(vpcRow?.originHost)
				assert.isNull(vpcRow?.originPort)
				assert.strictEqual(vpcRow?.originScheme, "postgres")

				// Rename one config and drop the other; the next discovery pass (TTL-gated)
				// updates in place and soft-deletes the vanished row.
				fetchOptions.hyperdriveConfigs = [{ ...hyperdriveMysqlFixture, name: "maple-mysql-renamed" }]
				yield* TestClock.setTime(T0 + 61 * MIN)
				yield* service.pollOrg(ORG)
				const second = yield* service.listHyperdriveConfigs(ORG)
				assert.strictEqual(second.length, 1)
				assert.strictEqual(second[0]!.name, "maple-mysql-renamed")

				const database = yield* Database
				const allRows = yield* database.execute((db) =>
					db.run(PG.from(CloudflareHyperdriveConfigs).select()),
				)
				const deleted = allRows.find((row) => row.configId === hyperdriveVpcFixture.id)
				assert.isNotNull(deleted?.deletedAt)

				// A re-appearing config resurrects its soft-deleted row (identity kept).
				fetchOptions.hyperdriveConfigs = [hyperdriveMysqlFixture, hyperdriveVpcFixture]
				yield* TestClock.setTime(T0 + 122 * MIN)
				yield* service.pollOrg(ORG)
				const third = yield* service.listHyperdriveConfigs(ORG)
				assert.strictEqual(third.length, 2)
				assert.strictEqual(
					third.find((row) => row.configId === hyperdriveVpcFixture.id)?.id,
					deleted!.id,
				)
			}).pipe(Effect.provide(makeLayer(testDb, captured, fetchOptions)))
		},
	)

	it.effect("a hyperdrive discovery failure degrades open: rows kept, analytics not disabled", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const fetchOptions: FetchOptions = { hyperdriveConfigs: [hyperdriveMysqlFixture] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService

			yield* service.pollOrg(ORG)
			assert.strictEqual((yield* service.listHyperdriveConfigs(ORG)).length, 1)

			// A pre-hyperdrive-scope grant surfaces as a 403 on the listing only —
			// the discovery pass must keep last-known rows and leave analytics running.
			fetchOptions.hyperdriveStatus = 403
			yield* TestClock.setTime(T0 + 61 * MIN)
			const summary = yield* service.pollOrg(ORG)
			assert.isNull(summary.skipped)

			const rows = yield* service.listHyperdriveConfigs(ORG)
			assert.strictEqual(rows.length, 1)
			const stateRows = yield* loadStateRows
			assert.isTrue(stateRows.every((row) => row.enabled))
		}).pipe(Effect.provide(makeLayer(testDb, captured, fetchOptions)))
	})

	// Seed a workers anchor (discovery + settings pre-stamped fresh so the whole call budget goes to
	// polling) plus `zoneCount` http zone rows with null settingsJson ⇒ no retention cap ⇒ the full
	// 24h backfill. >10 zones means the 24h history can't fit in one 50-call tick.
	const seedManyZones = (zoneCount: number) =>
		Effect.gen(function* () {
			yield* seedStateRow({
				dataset: "workers_invocations",
				zoneId: "",
				discoveredAt: T0 - 5 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			for (let i = 0; i < zoneCount; i++) {
				yield* seedStateRow({
					dataset: "http_requests",
					zoneId: `zone-${i}`,
					zoneName: `zone-${i}.example.com`,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
		})

	// floor(now - 10min - 24h) — the 24h backfill floor when the plan imposes no retention cap.
	const BACKFILL_FLOOR = Date.parse("2026-07-01T11:50:00Z")
	const HORIZON = Date.parse("2026-07-02T11:50:00Z")

	it.effect(
		"prioritizes live data: the head reaches the horizon in one tick while the 24h backfill stays in progress",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				yield* seedManyZones(12)

				const service = yield* CloudflareAnalyticsService
				const summary = yield* service.pollOrg(ORG)
				assert.isNull(summary.skipped)

				const httpRows = (yield* loadStateRows).filter((row) => row.dataset === "http_requests")
				assert.strictEqual(httpRows.length, 12)
				for (const row of httpRows) {
					// Head is live within the FIRST tick — the newest window landed immediately, so the
					// integration card reads "just now" instead of hours ago.
					assert.strictEqual(row.watermarkAt, HORIZON)
					// History is still filling in behind it: the backfill frontier started walking down
					// from the seed but couldn't reach the 24h floor under the per-tick call budget.
					assert.isNotNull(row.backfillAt)
					assert.isAbove(row.backfillAt!, BACKFILL_FLOOR)
					assert.isBelow(row.backfillAt!, HORIZON)
				}
				// Budget-bound tick (that's WHY history is incomplete) — the head still won the race.
				// Pinned to the floor rather than a magic number so retuning the adaptive cap
				// doesn't turn this into a false failure.
				assert.isAtLeast(summary.callsMade, 5)
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect("a budget-bound tick says so on the poll span, with the work it left behind", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const { tracer, named } = recordSpans()
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedManyZones(12)

			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG).pipe(Effect.withTracer(tracer))

			const [poll] = named("CloudflareAnalyticsService.pollConnection")
			assert.strictEqual(poll!.attributes.get("maple.cloudflare.stop_reason"), "budget_exhausted")
			assert.isAbove(Number(poll!.attributes.get("maple.cloudflare.pending_items")), 0)
			assert.strictEqual(poll!.attributes.get("maple.cloudflare.budget_used_before"), 0)
			// Chunk spans tell head from backfill, so the cut-short history is visible per window.
			const phases = named("CloudflareAnalyticsService.pollDatasetChunk").map((span) =>
				span.attributes.get("maple.cloudflare.phase"),
			)
			assert.include(phases, "head")
			assert.include(phases, "backfill")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("the backfill frontier walks down to the 24h floor over subsequent ticks, then stops", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedManyZones(12)

			const service = yield* CloudflareAnalyticsService
			// Same wall-clock across ticks: the head stays put at the horizon; each tick drains more
			// history until the backfill frontier bottoms out at the 24h floor.
			yield* Effect.forEach([1, 2, 3, 4, 5], () => service.pollOrg(ORG), { discard: true })

			const httpRows = (yield* loadStateRows).filter((row) => row.dataset === "http_requests")
			for (const row of httpRows) {
				assert.strictEqual(row.watermarkAt, HORIZON)
				assert.strictEqual(row.backfillAt, BACKFILL_FLOOR)
			}
			// One more tick is a no-op: caught up on both frontiers, nothing left to ingest.
			const idle = yield* service.pollOrg(ORG)
			assert.strictEqual(idle.rowsIngested, 0)
			assert.strictEqual(idle.callsMade, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	// One account's state as of a steady tick: discovery and settings fresh, every row's head
	// `behindMs` short of the horizon with history already complete, so the tick is all head work.
	const seedBehindAccount = (accountId: string, zoneCount: number, behindMs: number) =>
		Effect.gen(function* () {
			const database = yield* Database
			const stamps = {
				orgId: ORG,
				accountId,
				settingsFetchedAt: T0 - 5 * MIN,
				watermarkAt: HORIZON - behindMs,
				backfillAt: BACKFILL_FLOOR,
				createdAt: T0 - 60 * MIN,
				updatedAt: T0 - 60 * MIN,
			}
			yield* database.execute((db) =>
				db.run(
					PG.insertInto(CloudflareAnalyticsState).values([
						{
							...stamps,
							id: randomUUID(),
							dataset: "workers_invocations",
							zoneId: "",
							discoveredAt: T0 - 5 * MIN,
						},
						...Array.from({ length: zoneCount }, (_, i) => ({
							...stamps,
							id: randomUUID(),
							dataset: "http_requests",
							zoneId: `${accountId}-zone-${i}`,
							zoneName: `${accountId}-zone-${i}.example.com`,
						})),
					]),
				),
			)
		})

	const watermarksOf = (accountId: string) =>
		loadStateRows.pipe(
			Effect.map((rows) => rows.filter((row) => row.accountId === accountId)),
			Effect.map((rows) => ({
				http: rows.filter((row) => row.dataset === "http_requests").map((row) => row.watermarkAt),
				workers: rows.find((row) => row.dataset === "workers_invocations")?.watermarkAt,
			})),
		)

	it.effect("a busy account cannot starve the grant's other account of calls", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const SMALL = "acct-small"
		const { tracer, named } = recordSpans()
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			// The busy account comes first in status order AND is further behind: 40 zones six
			// hours back is ~30 head documents, more than the whole tick.
			yield* seedConnection(ANALYTICS_SCOPE, [
				{ id: ACCOUNT_ID, name: "Busy Account" },
				{ id: SMALL, name: "Small Account" },
			])
			yield* seedBehindAccount(ACCOUNT_ID, 40, 6 * 60 * MIN)
			yield* seedBehindAccount(SMALL, 1, 3 * 60 * MIN)
			yield* seedGrantCap(20)

			const service = yield* CloudflareAnalyticsService
			const first = yield* service.pollOrg(ORG).pipe(Effect.withTracer(tracer))
			// The grant's total is unchanged; it is only split differently.
			assert.strictEqual(first.callsMade, 20)
			const polls = named("CloudflareAnalyticsService.pollConnection")
			const smallPoll = polls.find(
				(span) => span.attributes.get("maple.cloudflare.account_id") === SMALL,
			)
			assert.isAbove(Number(smallPoll!.attributes.get("maple.cloudflare.calls")), 0)

			// Both of the small account's datasets moved in the very first tick...
			const afterOne = yield* watermarksOf(SMALL)
			assert.isAbove(afterOne.workers!, HORIZON - 3 * 60 * MIN)
			assert.isAbove(afterOne.http[0]!, HORIZON - 3 * 60 * MIN)
			// ...and the busy account still got the rest of the budget.
			const busy = yield* watermarksOf(ACCOUNT_ID)
			assert.isAbove(busy.workers!, HORIZON - 6 * 60 * MIN)
			assert.isTrue(busy.http.every((watermark) => watermark! > HORIZON - 6 * 60 * MIN))

			// One window per head document per tick: three ticks bring it to the horizon.
			yield* service.pollOrg(ORG)
			yield* service.pollOrg(ORG)
			const caughtUp = yield* watermarksOf(SMALL)
			assert.strictEqual(caughtUp.workers, HORIZON)
			assert.deepStrictEqual(caughtUp.http, [HORIZON])
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("a caught-up account leaves its share of the budget to a busy sibling", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const IDLE = "acct-idle"
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection(ANALYTICS_SCOPE, [
				{ id: ACCOUNT_ID, name: "Busy Account" },
				{ id: IDLE, name: "Idle Account" },
			])
			yield* seedBehindAccount(ACCOUNT_ID, 40, 6 * 60 * MIN)
			// Head at the horizon, history complete, settings fresh: nothing to spend a call on.
			yield* seedBehindAccount(IDLE, 1, 0)
			yield* seedGrantCap(20)

			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.callsMade, 20)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("an account dataset crowded out by zone documents leads the next tick", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// 210 zones are 21 zone documents per window: one round of head work already
			// outspends the tick, and the account document plans after them at equal windows.
			yield* seedBehindAccount(ACCOUNT_ID, 210, 2 * 60 * MIN)
			yield* seedGrantCap(20)

			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			assert.strictEqual((yield* watermarksOf(ACCOUNT_ID)).workers, HORIZON - 2 * 60 * MIN)
			// Its watermark is now the oldest, so it goes first instead of waiting for every zone
			// to reach the horizon. (The spent cap grew; pin it so the tick is one round again.)
			yield* seedGrantCap(20)
			yield* service.pollOrg(ORG)
			assert.strictEqual((yield* watermarksOf(ACCOUNT_ID)).workers, HORIZON - 60 * MIN)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg disables state rows for vanished zones", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: "gone-zone",
				zoneName: "gone.example.com",
				watermarkAt: T0 - 20 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const rows = yield* loadStateRows
			const gone = rows.find((row) => row.zoneId === "gone-zone")
			assert.isDefined(gone)
			assert.isFalse(gone!.enabled)
			assert.include(gone!.lastError ?? "", "no longer present")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg does NOT disable unseen zones when the zone listing is truncated", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// A zone the account still owns, but which fell past the 200-zone
			// discovery cap of a 201-zone listing: unseen, not removed.
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: "beyond-cap-zone",
				zoneName: "beyond.example.com",
				watermarkAt: T0 - 20 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const rows = yield* loadStateRows
			// A vanished row fails the test through the error channel, so the
			// assertions below get a narrowed row instead of a `!`.
			const beyond = yield* Effect.fromOption(
				Arr.findFirst(rows, (row) => row.zoneId === "beyond-cap-zone"),
			)
			assert.isTrue(beyond.enabled)
			assert.notInclude(beyond.lastError ?? "", "no longer present")
		}).pipe(Effect.provide(makeLayer(testDb, captured, { zonesTotal: 201 })))
	})

	describe("zone selection", () => {
		const SECOND_ZONE_ID = "zone-2"
		const twoZones = [zoneFixture, { ...zoneFixture, id: SECOND_ZONE_ID, name: "beta.example" }]
		const ADMIN = Schema.decodeUnknownSync(UserId)("user_admin")
		const enabledByZone = loadStateRows.pipe(
			Effect.map((rows) =>
				Object.fromEntries(
					rows
						.filter((row) => row.dataset === "http_requests")
						.map((row) => [row.zoneId, row.enabled]),
				),
			),
		)

		it.effect("a zone the customer did not pick is created paused and never queried", () => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			const graphqlZoneTags: Array<ReadonlyArray<string>> = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				const database = yield* Database
				yield* database.execute((db) =>
					db.run(
						PG.insertInto(CloudflareZoneSettings).values({
							orgId: ORG,
							accountId: ACCOUNT_ID,
							watchNewZones: false,
							zoneOverrides: { [ZONE_ID]: true },
							createdAt: T0,
							updatedAt: T0,
						}),
					),
				)
				const service = yield* CloudflareAnalyticsService
				yield* service.pollOrg(ORG)

				assert.deepStrictEqual(yield* enabledByZone, { [ZONE_ID]: true, [SECOND_ZONE_ID]: false })
				const queried = new Set(graphqlZoneTags.flat())
				assert.isTrue(queried.has(ZONE_ID))
				assert.isFalse(queried.has(SECOND_ZONE_ID))

				const status = yield* service.getIntegrationStatus(ORG)
				const account = status.accounts?.[0]
				assert.strictEqual(account?.watchNewZones, false)
				assert.deepStrictEqual(
					account?.zones.map((zone) => [zone.id, zone.watched]),
					[
						[SECOND_ZONE_ID, false],
						[ZONE_ID, true],
					],
				)
			}).pipe(Effect.provide(makeLayer(testDb, captured, { zones: twoZones, graphqlZoneTags })))
		})

		it.effect("pausing a zone survives a reconnect reset and the next discovery", () => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			const graphqlZoneTags: Array<ReadonlyArray<string>> = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				const service = yield* CloudflareAnalyticsService
				yield* service.pollOrg(ORG)

				yield* service.setZoneSettings(ORG, ADMIN, {
					accountId: ACCOUNT_ID,
					watchNewZones: true,
					zones: [{ zoneId: SECOND_ZONE_ID, watched: false }],
				})
				assert.deepStrictEqual(yield* enabledByZone, { [ZONE_ID]: true, [SECOND_ZONE_ID]: false })

				// A reconnect re-enables every row and forces discovery on the next tick.
				yield* service.resetOrgState(ORG)
				graphqlZoneTags.length = 0
				yield* TestClock.setTime(T0 + 15 * MIN)
				yield* service.pollOrg(ORG)

				assert.deepStrictEqual(yield* enabledByZone, { [ZONE_ID]: true, [SECOND_ZONE_ID]: false })
				const queried = new Set(graphqlZoneTags.flat())
				assert.isTrue(queried.has(ZONE_ID))
				assert.isFalse(queried.has(SECOND_ZONE_ID))
			}).pipe(Effect.provide(makeLayer(testDb, captured, { zones: twoZones, graphqlZoneTags })))
		})

		it.effect("resuming a zone re-enables it and leaves a vanished zone disabled", () => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedStateRow({ dataset: "http_requests", zoneId: ZONE_ID, zoneName: ZONE_NAME })
				yield* seedStateRow({
					dataset: "http_requests",
					zoneId: "gone-zone",
					zoneName: "gone.example.com",
					enabled: false,
					lastError: "Zone no longer present on the Cloudflare account",
				})
				const service = yield* CloudflareAnalyticsService
				yield* service.setZoneSettings(ORG, ADMIN, {
					accountId: ACCOUNT_ID,
					watchNewZones: true,
					zones: [{ zoneId: ZONE_ID, watched: false }],
				})
				assert.deepStrictEqual(yield* enabledByZone, { [ZONE_ID]: false, "gone-zone": false })

				yield* service.setZoneSettings(ORG, ADMIN, {
					accountId: ACCOUNT_ID,
					watchNewZones: true,
					zones: [
						{ zoneId: ZONE_ID, watched: true },
						{ zoneId: "gone-zone", watched: true },
					],
				})
				assert.deepStrictEqual(yield* enabledByZone, { [ZONE_ID]: true, "gone-zone": false })
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		})

		it.effect("rejects a zone that is not on the account", () => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* seedStateRow({ dataset: "http_requests", zoneId: ZONE_ID, zoneName: ZONE_NAME })
				const service = yield* CloudflareAnalyticsService
				const error = yield* Effect.flip(
					service.setZoneSettings(ORG, ADMIN, {
						accountId: "acct-other",
						watchNewZones: true,
						zones: [{ zoneId: ZONE_ID, watched: false }],
					}),
				)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
				assert.deepStrictEqual(yield* enabledByZone, { [ZONE_ID]: true })
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		})
	})

	it.effect("pollOrg skips when another tick holds the lease", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({ dataset: "workers_invocations", leaseUntil: T0 + 3 * MIN })
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.skipped, "lease held by another tick")
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("a tick that lost its lease does not clear the successor's on release", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		// Simulate the overlap: while this tick is mid-poll (first GraphQL call),
		// a successor claims the anchor lease — as happens when a tick outlives
		// LEASE_MS. The finishing tick's release must be a compare-and-set on the
		// lease value it wrote, so the successor's live lease survives.
		const SUCCESSOR_LEASE = new Date(T0 + 3 * MIN)
		let injected = false
		const onGraphql = async () => {
			if (injected) return
			injected = true
			await executeSql(
				testDb,
				`UPDATE cloudflare_analytics_state SET lease_until = $1
				 WHERE dataset = 'workers_invocations' AND zone_id = ''`,
				[SUCCESSOR_LEASE],
			)
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "workers_invocations",
				zoneId: "",
				discoveredAt: T0 - 5 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)

			const anchor = yield* Effect.promise(() =>
				queryFirstRow<{ lease_until: Date | string | null }>(
					testDb,
					`SELECT lease_until FROM cloudflare_analytics_state
					 WHERE dataset = 'workers_invocations' AND zone_id = ''`,
				),
			)
			// Pre-CAS this was nulled by the stale tick's unconditional release,
			// letting a third tick overlap the successor.
			assert.strictEqual(new Date(anchor?.lease_until ?? 0).getTime(), SUCCESSOR_LEASE.getTime())
		}).pipe(Effect.provide(makeLayer(testDb, captured, { onGraphql })))
	})

	it.effect("pollOrg reclaims a far-future (corrupt) lease instead of skipping forever", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// A live lease is always bounded by now+LEASE_MS (4min); anything beyond 2x that (8min)
			// can't come from normal operation — e.g. a crashed writer left a bogus far-future value
			// — so it must be treated as corrupt and reclaimed rather than wedging the org forever.
			yield* seedStateRow({ dataset: "workers_invocations", leaseUntil: T0 + 60 * MIN })
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isNull(summary.skipped)
			assert.isAbove(summary.rowsIngested, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollAllOrgs rollup reports skip counts and per-org reasons", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Reuse the lease-held skip scenario: a live 3min lease means this tick's pollOrg call
			// skips instead of polling.
			yield* seedStateRow({ dataset: "workers_invocations", leaseUntil: T0 + 3 * MIN })
			const service = yield* CloudflareAnalyticsService
			const result = yield* service.pollAllOrgs()
			assert.strictEqual(result.rowsIngested, 0)
			assert.strictEqual(result.skipped, 1)
			assert.strictEqual(result.perOrg.length, 1)
			assert.strictEqual(result.perOrg[0]!.skipped, "lease held by another tick")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollAllOrgs skips connections stamped revoked; resetOrgState clears the stamp", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.update(OAuthConnections)
						.set({ revokedAt: T0 - MIN })
						.where(($) => [$.orgId.eq(ORG)]),
				),
			)
			const service = yield* CloudflareAnalyticsService
			const result = yield* service.pollAllOrgs()
			assert.strictEqual(result.perOrg.length, 0)
			assert.strictEqual(result.rowsIngested, 0)

			yield* service.resetOrgState(ORG)
			const rows = yield* database.execute((db) =>
				db.run(
					PG.from(OAuthConnections)
						.select()
						.where(($) => [$.orgId.eq(ORG)]),
				),
			)
			assert.isNull(rows[0]!.revokedAt)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("resetOrgState re-enables disabled rows and clears error/discovery state", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "workers_invocations",
				enabled: false,
				lastError: "token revoked",
				lastErrorAt: T0 - 10 * MIN,
				discoveredAt: T0 - 10 * MIN,
			})
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				enabled: false,
				lastError: "token revoked",
				lastErrorAt: T0 - 10 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.resetOrgState(ORG)

			const rows = yield* loadStateRows
			assert.strictEqual(rows.length, 2)
			for (const row of rows) {
				assert.isTrue(row.enabled)
				assert.isNull(row.lastError)
				assert.isNull(row.lastErrorAt)
			}
			const anchor = rows.find((row) => row.dataset === "workers_invocations")
			assert.isNull(anchor!.discoveredAt)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("findHttpZone returns the enabled zone's account and skips disabled or orphaned rows", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: "z-off",
				zoneName: "off.example.com",
				enabled: false,
			})
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: "z-orphan",
				zoneName: "orphan.example.com",
				accountId: "",
			})
			yield* seedStateRow({ dataset: "http_requests", zoneId: ZONE_ID, zoneName: ZONE_NAME })
			const service = yield* CloudflareAnalyticsService

			const found = yield* service.findHttpZone(ORG, ZONE_NAME)
			assert.deepStrictEqual(found, { zoneId: ZONE_ID, accountId: ACCOUNT_ID })
			assert.isNull(yield* service.findHttpZone(ORG, "off.example.com"))
			assert.isNull(yield* service.findHttpZone(ORG, "orphan.example.com"))
			assert.isNull(yield* service.findHttpZone(asOrgId("org_other"), ZONE_NAME))
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg records GraphQL errors without advancing watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.rowsIngested, 0)
			// The failure is now a first-class value on the summary (the seam turns it into an
			// exception event + ERROR log), not just a silent DB write.
			assert.isAbove(summary.failures.length, 0)
			assert.isTrue(summary.failures.some((failure) => failure.message.includes("quota exceeded")))
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "quota exceeded")
			assert.strictEqual(httpRow!.watermarkAt, T0 - 30 * MIN)
			assert.strictEqual(captured.length, 0)
		}).pipe(
			Effect.provide(makeLayer(testDb, captured, { graphqlErrors: [{ message: "quota exceeded" }] })),
		)
	})

	it.effect("each tick reports onto the grant's source, and a reconnect clears a revoked grant", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const fetchOptions: Types.Mutable<FetchOptions> = {
			graphqlErrors: [{ message: "quota exceeded" }],
		}
		const readSource = Effect.promise(() =>
			queryFirstRow<{
				last_poll_ok_at: Date | null
				last_poll_error: string | null
				disconnected_at: Date | null
				poll_resources: { total: number; unhealthy: number } | null
			}>(
				testDb,
				"SELECT last_poll_ok_at, last_poll_error, disconnected_at, poll_resources FROM sources WHERE platform = 'cloudflare'",
			),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const failed = yield* readSource
			assert.include(failed!.last_poll_error ?? "", "quota exceeded")
			assert.isNull(failed!.last_poll_ok_at)
			assert.isAbove(failed!.poll_resources?.total ?? 0, 1)
			assert.strictEqual(failed!.poll_resources?.unhealthy, failed!.poll_resources?.total)

			fetchOptions.graphqlErrors = undefined
			yield* TestClock.adjust("5 minutes")
			yield* service.pollOrg(ORG)
			const healthy = yield* readSource
			assert.isNull(healthy!.last_poll_error)
			assert.isNotNull(healthy!.last_poll_ok_at)
			assert.deepStrictEqual(healthy!.poll_resources, {
				total: failed!.poll_resources?.total ?? 0,
				unhealthy: 0,
			})

			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.update(OAuthConnections)
						.set({ revokedAt: T0 })
						.where(($) => [$.orgId.eq(ORG)]),
				),
			)
			yield* service.pollOrg(ORG)
			const revoked = yield* readSource
			assert.isNotNull(revoked!.disconnected_at)
			assert.match(revoked!.last_poll_error ?? "", /Reconnect Cloudflare/)

			yield* service.resetOrgState(ORG)
			yield* TestClock.adjust("5 minutes")
			yield* service.pollOrg(ORG)
			const reconnected = yield* readSource
			assert.isNull(reconnected!.disconnected_at)
			assert.isNull(reconnected!.last_poll_error)
		}).pipe(Effect.provide(makeLayer(testDb, captured, fetchOptions)))
	})

	it.effect("pollOrg surfaces a zone authz failure as an observable failure, not just a DB write", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// Regression for the invisible outage: a Cloudflare "not authorized" on the zone dataset
			// used to be written ONLY to cloudflare_analytics_state.lastError with zero telemetry, so a
			// fully-broken integration was invisible to find_errors/logs for hours. It must now be a
			// classified, first-class failure on the summary (which the seam turns into an exception
			// event + ERROR log through Maple's own error pipeline).
			const authz = summary.failures.find(
				(failure) => failure.kind === "authz" && failure.datasetId === "http_requests",
			)
			assert.isDefined(authz)
			assert.strictEqual(authz!.scope, "zone")
			assert.include(authz!.message, "not authorized")
			assert.strictEqual(summary.rowsIngested, 0)
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "not authorized")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [{ message: "not authorized to access these fields" }],
				}),
			),
		)
	})

	it.effect("a Cloudflare rate limit is a quiet org-wide backoff, not a per-dataset failure", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const { tracer, named } = recordSpans()
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Several datasets behind the head: without the collapse this tick produced one
			// CloudflareAnalyticsPollError per dataset × zone-chunk (~1.7k events/day in prod).
			for (const dataset of ["http_requests", "firewall_events", "dns_queries"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG).pipe(Effect.withTracer(tracer))
			// The poll span says why it stopped and that the windows are still owed.
			const [poll] = named("CloudflareAnalyticsService.pollConnection")
			assert.strictEqual(poll!.attributes.get("maple.cloudflare.stop_reason"), "rate_limited")
			assert.isAbove(Number(poll!.attributes.get("maple.cloudflare.pending_items")), 0)
			assert.include(
				named("CloudflareAnalyticsService.pollDatasetChunk").map((span) =>
					span.attributes.get("maple.cloudflare.outcome"),
				),
				"rate-limited",
			)
			// Classified as `rate-limited` → no failure outcome at all, so nothing reaches the
			// observeDatasetFailure seam that records exception events.
			assert.strictEqual(summary.failures.length, 0)
			assert.strictEqual(summary.rowsIngested, 0)
			// One depleted budget stops the org's tick instead of burning the whole call budget:
			// at most the settings probe plus the single document that hit the limiter.
			assert.isAtMost(summary.callsMade, 2)

			const rows = yield* loadStateRows
			for (const row of rows) {
				// Our own pacing is not a tenant-facing integration error, and nothing is disabled.
				assert.isNull(row.lastError, `${row.dataset} must not record a tenant-facing error`)
				assert.isTrue(row.enabled, `${row.dataset} must stay enabled`)
				// Frontiers stay put — the same windows are retried after the backoff. (Rows that
				// discovery created this tick simply have no watermark yet.)
				if (row.watermarkAt != null) assert.strictEqual(row.watermarkAt, T0 - 30 * MIN)
			}
			// The lease is held rather than released, so the next tick skips this org for ~5 min.
			const anchor = rows.find((row) => row.dataset === "workers_invocations" && row.zoneId === "")
			assert.isNotNull(anchor!.leaseUntil)
			assert.isAbove(anchor!.leaseUntil!, T0)
			assert.strictEqual(captured.length, 0)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{ message: "Rate limiter budget depleted. Please try again after 5 minutes." },
					],
				}),
			),
		)
	})

	it.effect("a rate-limited tick halves the grant's call cap, never below the floor", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const { tracer, named } = recordSpans()
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService

			// No stored cap yet: the tick runs at the starting cap and halves it.
			yield* service.pollOrg(ORG).pipe(Effect.withTracer(tracer))
			const [org] = named("CloudflareAnalyticsService.pollOrg")
			assert.strictEqual(org!.attributes.get("maple.cloudflare.grant_cap"), 60)
			assert.strictEqual(org!.attributes.get("maple.cloudflare.grant_cap_next"), 30)
			assert.deepStrictEqual(yield* grantCapsOf, [30])

			// Near the floor a halving clamps to it, and a further rate limit keeps it there.
			yield* seedGrantCap(8)
			yield* TestClock.setTime(T0 + 6 * MIN)
			yield* service.pollOrg(ORG)
			assert.deepStrictEqual(yield* grantCapsOf, [5])
			yield* TestClock.setTime(T0 + 12 * MIN)
			yield* service.pollOrg(ORG)
			assert.deepStrictEqual(yield* grantCapsOf, [5])
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{ message: "Rate limiter budget depleted. Please try again after 5 minutes." },
					],
				}),
			),
		)
	})

	it.effect("a tick that spends the whole cap grows it, up to the ceiling", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// 100 zones with a full 24h backfill owed: far more work than any cap allows.
			yield* seedManyZones(100)
			const service = yield* CloudflareAnalyticsService

			const first = yield* service.pollOrg(ORG)
			assert.strictEqual(first.callsMade, 60)
			assert.deepStrictEqual(yield* grantCapsOf, [65])

			// Growth stops at the ceiling.
			yield* seedGrantCap(148)
			const second = yield* service.pollOrg(ORG)
			assert.strictEqual(second.callsMade, 148)
			assert.deepStrictEqual(yield* grantCapsOf, [150])
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("a tick with calls to spare holds the cap where it is", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedBehindAccount(ACCOUNT_ID, 1, 30 * MIN)
			yield* seedGrantCap(40)
			const service = yield* CloudflareAnalyticsService

			const summary = yield* service.pollOrg(ORG)
			assert.isAbove(summary.callsMade, 0)
			assert.isBelow(summary.callsMade, 40)
			assert.deepStrictEqual(yield* grantCapsOf, [40])
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("an unattributed 'disabled' error does not cascade across a batched document", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Two zone datasets sharing one window → one batched document with two parts.
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// The pathless "not enabled" error can't be attributed to either selection —
			// disabling both healthy datasets on that ambiguity would be destructive, so it
			// must degrade to a retryable failure instead.
			assert.isAbove(summary.failures.length, 0)
			const rows = yield* loadStateRows
			for (const dataset of ["http_requests", "firewall_events"]) {
				const row = rows.find((r) => r.dataset === dataset && r.zoneId === ZONE_ID)
				assert.isTrue(row!.enabled, `${dataset} must stay enabled`)
			}
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [{ message: "this dataset is not enabled for your zone" }],
				}),
			),
		)
	})

	it.effect("the path and dimension datasets ride the HTTP zone document, not extra calls", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const graphqlQueries: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Every zone dataset at the same watermark → one (scope, window) batch key. Backfill is
			// already at the floor, so exactly one head window runs and the document count is exact.
			for (const dataset of [
				"http_requests",
				"http_paths",
				"http_dimensions",
				"firewall_events",
				"dns_queries",
			]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					backfillAt: BACKFILL_FLOOR,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)

			const zoneDocs = graphqlQueries.filter((q) => q.includes("MapleCfZoneAnalytics"))
			assert.strictEqual(zoneDocs.length, 1)
			for (const alias of [
				"groups:",
				"latency:",
				"paths:",
				"pathErrors:",
				"countryAgg:",
				"clientAgg:",
			]) {
				assert.include(zoneDocs[0]!, alias)
			}
		}).pipe(Effect.provide(makeLayer(testDb, captured, { graphqlQueries })))
	})

	it.effect("a path-attributed 'disabled' error disables only the owning dataset", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const rows = yield* loadStateRows
			const firewall = rows.find((r) => r.dataset === "firewall_events" && r.zoneId === ZONE_ID)
			const http = rows.find((r) => r.dataset === "http_requests" && r.zoneId === ZONE_ID)
			assert.isFalse(firewall!.enabled)
			assert.isTrue(http!.enabled)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message: "firewallEventsAdaptiveGroups is not enabled for this zone",
							path: ["viewer", "zones", 0, "firewall"],
						},
					],
				}),
			),
		)
	})

	it.effect("a plan-gated clientRequestPath keeps the rest of the HTTP cube flowing", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "http_paths"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const rows = yield* loadStateRows
			// This is the whole reason paths are their own DatasetDef: had `paths` been an alias of
			// http_requests, this error would have taken requests, bytes, visits and latency with it.
			assert.isFalse(rows.find((r) => r.dataset === "http_paths")!.enabled)
			assert.isTrue(rows.find((r) => r.dataset === "http_requests")!.enabled)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message: "does not have access to the field clientRequestPath",
							path: ["viewer", "zones", 0, "paths"],
						},
					],
				}),
			),
		)
	})

	it.effect(
		"a plan-gated 'does not have access to the path' error disables the dataset without telemetry",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				for (const dataset of ["http_requests", "firewall_events"]) {
					yield* seedStateRow({
						dataset,
						zoneId: ZONE_ID,
						zoneName: ZONE_NAME,
						watermarkAt: T0 - 30 * MIN,
						settingsFetchedAt: T0 - 5 * MIN,
					})
				}
				const service = yield* CloudflareAnalyticsService
				const summary = yield* service.pollOrg(ORG)
				// Cloudflare gates firewall_events behind the zone's plan ("does not have access to the
				// path ... access controls"). That is an expected per-plan degradation — the dataset must
				// be quietly disabled (like a "not enabled" error), NOT raised as an AnalyticsPollError.
				assert.strictEqual(summary.failures.length, 0)
				const rows = yield* loadStateRows
				const firewall = rows.find((r) => r.dataset === "firewall_events" && r.zoneId === ZONE_ID)
				const http = rows.find((r) => r.dataset === "http_requests" && r.zoneId === ZONE_ID)
				assert.isFalse(firewall!.enabled, "plan-gated dataset must be disabled")
				// The clean sibling wasn't the problem — Cloudflare voids the whole batch's `data` when one
				// selection is gated. It must not be dragged into a "carried no data" failure.
				assert.isTrue(http!.enabled, "clean sibling must stay enabled")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, captured, {
						graphqlErrors: [
							{
								message:
									"zone 'z' does not have access to the path. Refer to this page for more details about access controls: https://developers.cloudflare.com/analytics/graphql-api/errors/",
								path: ["viewer", "zones", 0, "firewall"],
							},
						],
					}),
				),
			)
		},
	)

	it.effect("a genuine error alongside a plan-gated one still fails the clean siblings", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// firewall is plan-gated (disabled), but the batch also carried a genuine "quota exceeded"
			// error. Because not ALL errors are plan-gating, the clean sibling (http) must still surface
			// a failure — the plan-gating skip must never swallow a real outage.
			const rows = yield* loadStateRows
			const firewall = rows.find((r) => r.dataset === "firewall_events" && r.zoneId === ZONE_ID)
			assert.isFalse(firewall!.enabled)
			assert.isAbove(summary.failures.length, 0)
			assert.isTrue(summary.failures.some((failure) => failure.message.includes("quota exceeded")))
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message: "zone 'z' does not have access to the path. access controls",
							path: ["viewer", "zones", 0, "firewall"],
						},
						{ message: "quota exceeded" },
					],
				}),
			),
		)
	})

	it.effect("a plan-gated latency field on http_requests downgrades quantiles instead of disabling", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// Only the timing-quantile field is gated ("does not have access to the field
			// 'edgetimetofirstbytemsp50'"). The counters (requests/errors) still work, so the dataset
			// must stay enabled and merely drop quantiles — NOT be wholesale-disabled — with no telemetry.
			assert.strictEqual(summary.failures.length, 0)
			const http = (yield* loadStateRows).find(
				(r) => r.dataset === "http_requests" && r.zoneId === ZONE_ID,
			)
			assert.isTrue(http!.enabled, "counters still work — dataset must stay enabled")
			assert.isFalse(http!.quantilesAvailable, "gated latency field must downgrade quantiles")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message:
								"zone 'z' does not have access to the field 'edgetimetofirstbytemsp50' from the path",
							path: ["viewer", "zones", 0, "groups"],
						},
					],
				}),
			),
		)
	})

	it.effect("pollOrg records a zones-list auth failure, disables rows, and holds watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// A 401 on the zones list means Cloudflare no longer honors the token: the tick
			// aborts before any GraphQL/ingest work and flags the org for reconnect.
			assert.strictEqual(
				summary.skipped,
				"zone discovery failed: @maple/http/errors/IntegrationsRevokedError",
			)
			assert.strictEqual(summary.callsMade, 0)
			assert.strictEqual(summary.rowsIngested, 0)

			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.isDefined(httpRow)
			// Revocation records the error on every state row and disables them until reconnect…
			assert.include(httpRow!.lastError ?? "", "reconnect")
			assert.isFalse(httpRow!.enabled)
			// …while the watermark holds, so a reconnect resumes from where polling stopped.
			assert.strictEqual(httpRow!.watermarkAt, T0 - 30 * MIN)
			assert.strictEqual(otlpCalls.length, 0)
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls, zonesStatus: 401 })))
	})

	it.effect("pollOrg emits OTLP sum/gauge metrics to the ingest gateway", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isAbove(summary.rowsIngested, 0)
			assert.isAbove(otlpCalls.length, 0)

			// Attributed to the org via its public ingest key → the gateway routes it per-org
			// (managed Tinybird or the org's BYO ClickHouse), and meters it there.
			assert.isTrue(otlpCalls.every((call) => call.authorization.startsWith("Bearer maple_pk_")))

			// A well-formed OTLP envelope: request counts are a DELTA-temporality monotonic sum.
			const requestsMetric = otlpCalls
				.flatMap((call) => call.payload.resourceMetrics)
				.flatMap((rm) => rm.scopeMetrics)
				.flatMap((sm) => sm.metrics)
				.find((metric) => metric.name === "cloudflare.http.requests")
			assert.isDefined(requestsMetric)
			assert.isDefined(requestsMetric!.sum)
			assert.strictEqual(requestsMetric!.sum!.aggregationTemporality, 1)
			assert.strictEqual(requestsMetric!.sum!.isMonotonic, true)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls })))
	})

	it.effect("pollOrg records a gateway ingest failure without advancing watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.rowsIngested, 0)
			// The gateway was called and rejected the batch; the watermark holds for a retry.
			assert.isAbove(otlpCalls.length, 0)
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "ingest returned 500")
			assert.strictEqual(httpRow!.watermarkAt, T0 - 30 * MIN)
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls, metricsStatus: 500 })))
	})

	// Production: an org with no active plan raised a poll error and an upstream error span on
	// every tick. A 402 is billing state the tenant fixes, so it is health, not an exception.
	it.effect("a 402 from the gateway is plan-blocked: health recorded, no failure, lease held", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.failures.length, 0)
			assert.strictEqual(summary.rowsIngested, 0)
			// The first refusal ends the tick: one gateway call, not one per document.
			assert.strictEqual(otlpCalls.length, 1)
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "ingest returned 402")
			assert.strictEqual(httpRow!.watermarkAt, T0 - 30 * MIN)
			const anchor = rows.find((row) => row.dataset === "workers_invocations" && row.zoneId === "")
			assert.isAbove(anchor!.leaseUntil!, T0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls, metricsStatus: 402 })))
	})

	// Production: an edge-blocked ingest key got a 403 HTML block page, and every dataset of every
	// tick raised a poll error carrying the page. A refused key is health plus a backoff instead.
	it.effect("a 403 HTML block page from ingest is a refusal: short message, no failure, lease held", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		const metricsHtml =
			'<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
			"<head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>"
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: T0 - 30 * MIN,
					settingsFetchedAt: T0 - 5 * MIN,
				})
			}
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: T0 - 30 * MIN,
				settingsFetchedAt: T0 - 5 * MIN,
			})
			const service = yield* CloudflareAnalyticsService
			const first = yield* service.pollOrg(ORG)
			assert.strictEqual(first.failures.length, 0)
			assert.strictEqual(otlpCalls.length, 1)
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.strictEqual(
				httpRow!.lastError,
				'Cloudflare metrics ingest returned 403: HTML response "Attention Required! | Cloudflare" (cf-ray 8d1f2e3a4b5c6d7e-FRA)',
			)
			assert.strictEqual(httpRow!.watermarkAt, T0 - 30 * MIN)
			// The held lease makes the next tick skip the org instead of re-posting.
			yield* TestClock.adjust(MIN)
			yield* service.pollOrg(ORG)
			assert.strictEqual(otlpCalls.length, 1)
			yield* TestClock.adjust(10 * MIN)
			yield* service.pollOrg(ORG)
			assert.strictEqual(otlpCalls.length, 2)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls, metricsStatus: 403, metricsHtml })))
	})

	// Every account of an org posts with the same org key, so one refusal holds the siblings too.
	it.effect("an ingest refusal on one account holds the org's other accounts without posting", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		const SECOND_ACCOUNT = "acct-2"
		const secondZone = {
			...zoneFixture,
			id: "zone-2",
			name: "beta.example",
			account: { id: SECOND_ACCOUNT, name: "Second Account" },
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection(ANALYTICS_SCOPE, [
				{ id: ACCOUNT_ID, name: "Test Account" },
				{ id: SECOND_ACCOUNT, name: "Second Account" },
			])
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.failures.length, 0)
			assert.strictEqual(otlpCalls.length, 1)
			const rows = yield* loadStateRows
			const secondAnchor = rows.find(
				(row) => row.accountId === SECOND_ACCOUNT && row.dataset === "workers_invocations",
			)
			assert.include(secondAnchor!.lastError ?? "", "ingest returned 403")
			assert.isAbove(secondAnchor!.leaseUntil!, T0)
			// Neither account posts again inside the backoff.
			yield* TestClock.adjust(MIN)
			yield* service.pollOrg(ORG)
			assert.strictEqual(otlpCalls.length, 1)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					otlpCalls,
					metricsStatus: 403,
					zonesByAccount: { [ACCOUNT_ID]: [zoneFixture], [SECOND_ACCOUNT]: [secondZone] },
				}),
			),
		)
	})

	it.effect("getStatus reflects zone and workers state rows", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				lastSuccessAt: T0 - 5 * MIN,
				watermarkAt: T0 - 15 * MIN,
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				lastError: "boom",
				lastErrorAt: T0,
			})
			const service = yield* CloudflareAnalyticsService
			const status = yield* service.getStatus(ORG)
			assert.strictEqual(status.zones.length, 1)
			assert.deepStrictEqual(status.zones[0], {
				id: ZONE_ID,
				name: ZONE_NAME,
				enabled: true,
				lastSyncedAt: T0 - 5 * MIN,
				lastError: null,
				watermarkAt: T0 - 15 * MIN,
				backfillAt: null,
				watched: true,
			})
			assert.strictEqual(status.workers?.lastError, "boom")
			assert.strictEqual(status.workers?.watermarkAt, null)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect(
		"getIntegrationStatus returns a disconnected status and ignores state rows when not connected",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				// A leftover state row must not leak into the response once the OAuth connection is gone —
				// getIntegrationStatus short-circuits before reading analytics state.
				yield* seedStateRow({ dataset: "http_requests", zoneId: ZONE_ID, zoneName: ZONE_NAME })
				const service = yield* CloudflareAnalyticsService
				const status = yield* service.getIntegrationStatus(ORG)
				assert.isFalse(status.connected)
				assert.strictEqual(status.accountId, null)
				assert.strictEqual(status.accountName, null)
				assert.strictEqual(status.connectedByUserId, null)
				assert.strictEqual(status.scope, null)
				assert.isFalse(status.analyticsCapable)
				assert.deepStrictEqual(status.zones, [])
				assert.strictEqual(status.workers, null)
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect(
		"getIntegrationStatus merges the OAuth connection with analytics state for a connected org",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* seedConnection()
				yield* seedStateRow({
					dataset: "http_requests",
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					lastSuccessAt: T0 - 5 * MIN,
					watermarkAt: T0 - 15 * MIN,
				})
				yield* seedStateRow({
					dataset: "workers_invocations",
					lastError: "boom",
					lastErrorAt: T0,
				})
				const service = yield* CloudflareAnalyticsService
				const status = yield* service.getIntegrationStatus(ORG)
				assert.isTrue(status.connected)
				assert.strictEqual(status.accountId, ACCOUNT_ID)
				assert.strictEqual(status.accountName, "Test Account")
				assert.strictEqual(status.connectedByUserId, "user_1")
				assert.strictEqual(status.scope, ANALYTICS_SCOPE)
				// Full analytics scope → the card unlocks the analytics UI.
				assert.isTrue(status.analyticsCapable)
				assert.strictEqual(status.zones.length, 1)
				assert.strictEqual(status.zones[0]?.id, ZONE_ID)
				assert.strictEqual(status.zones[0]?.name, ZONE_NAME)
				assert.strictEqual(status.zones[0]?.lastSyncedAt, T0 - 5 * MIN)
				assert.strictEqual(status.workers?.lastError, "boom")
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect(
		"getIntegrationStatus reports analyticsCapable=false and null workers for a scope-limited token",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				// Connected, but the token lacks analytics.read — connected yet not analytics-capable,
				// and with no workers state row the workers block maps to null.
				yield* seedConnection("account-settings.read workers-scripts.read")
				const service = yield* CloudflareAnalyticsService
				const status = yield* service.getIntegrationStatus(ORG)
				assert.isTrue(status.connected)
				assert.isFalse(status.analyticsCapable)
				assert.deepStrictEqual(status.zones, [])
				assert.strictEqual(status.workers, null)
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect("getUsage folds warehouse rows into per-service usage", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = {
			rows: [
				{
					serviceName: "cloudflare-worker/my-worker",
					bucket: "2026-07-02T10:00:00.000Z",
					requests: 42.4,
					datapoints: 12,
					lastTimeUnix: "2026-07-02T10:55:00.000Z",
				},
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T10:00:00.000Z",
					requests: 100.2,
					datapoints: 24,
					lastTimeUnix: "2026-07-02T10:55:00.000Z",
				},
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T11:00:00.000Z",
					requests: 50,
					datapoints: 10,
					lastTimeUnix: "2026-07-02T11:40:00.000Z",
				},
			],
			// String-encoded like a BYO-CH response — exercises the CHNumber coercion.
			statsRows: [{ previousRequests: "120.4", firewallBlockedEvents: "30" }],
			calls: [],
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			const usage = yield* service.getUsage(ORG)

			assert.strictEqual(usage.windowEnd, T0)
			assert.strictEqual(usage.windowStart, T0 - 24 * 60 * MIN)
			assert.strictEqual(usage.bucketSeconds, 3600)
			assert.strictEqual(usage.totalRequests, 192)
			assert.strictEqual(usage.previousTotalRequests, 120)
			assert.strictEqual(usage.firewallBlockedEvents, 30)

			assert.strictEqual(usage.services.length, 2)
			const zone = usage.services[0]!
			assert.strictEqual(zone.kind, "zone")
			assert.strictEqual(zone.serviceName, "cloudflare/example.com")
			assert.strictEqual(zone.displayName, "example.com")
			assert.strictEqual(zone.totalRequests, 150)
			assert.strictEqual(zone.totalDatapoints, 34)
			assert.strictEqual(zone.lastDataAt, Date.parse("2026-07-02T11:40:00.000Z"))
			assert.strictEqual(zone.buckets.length, 2)
			assert.strictEqual(zone.buckets[0]?.bucketStart, Date.parse("2026-07-02T10:00:00.000Z"))
			assert.strictEqual(zone.buckets[0]?.requests, 100)

			const worker = usage.services[1]!
			assert.strictEqual(worker.kind, "worker")
			assert.strictEqual(worker.displayName, "my-worker")
			assert.strictEqual(worker.totalRequests, 42)

			// This org has no BYO-CH settings row (managed/Tinybird), so the gateway wrote its
			// metrics to Tinybird — both reads (usage + stats) must route to the ingest config.
			assert.strictEqual(queryStub.calls.length, 2)
			for (const call of queryStub.calls) {
				assert.strictEqual(call.options?.route, "ingest")
				assert.strictEqual(call.options?.profile, "aggregation")
				assert.strictEqual(call.orgId, ORG)
			}
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage reads the org's own warehouse for a write-ready BYO-CH org", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = { rows: [], calls: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Connected + schema_version == running version → gateway routes metrics to the
			// org's own ClickHouse, so the read must NOT route to the ingest (Tinybird) config.
			yield* seedByoClickHouse()
			const service = yield* CloudflareAnalyticsService
			yield* service.getUsage(ORG)

			assert.strictEqual(queryStub.calls.length, 2)
			for (const call of queryStub.calls) {
				assert.notStrictEqual(call.options?.route, "ingest")
			}
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage pins to ingest config for a drifted (not-ready) BYO-CH org", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = { rows: [], calls: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Stale schema_version → gateway falls back to Tinybird for this org's metrics,
			// so the read must route to the ingest config (its own CH would be empty).
			yield* seedByoClickHouse({ schemaVersion: "stale-schema-version" })
			const service = yield* CloudflareAnalyticsService
			yield* service.getUsage(ORG)

			assert.strictEqual(queryStub.calls.length, 2)
			for (const call of queryStub.calls) {
				assert.strictEqual(call.options?.route, "ingest")
			}
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage coerces ClickHouse string-encoded counts (BYO-CH raw-CH response)", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		// Raw ClickHouse `FORMAT JSON` serializes count()/UInt64 as STRINGS (Tinybird
		// returns numbers). A ready BYO-CH org reads its own CH, so `datapoints` (and
		// defensively `requests`) arrive as strings — they must be coerced, not thrown
		// inside the `CloudflareUsageBucket` Schema.Class (which would 500 with no body).
		const queryStub: CompiledQueryStub = {
			rows: [
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T10:00:00.000Z",
					requests: "100.2",
					datapoints: "24",
					lastTimeUnix: "2026-07-02T10:55:00.000Z",
				},
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T11:00:00.000Z",
					requests: "50",
					datapoints: "10",
					lastTimeUnix: "2026-07-02T11:40:00.000Z",
				},
			],
			calls: [],
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedByoClickHouse()
			const service = yield* CloudflareAnalyticsService
			const usage = yield* service.getUsage(ORG)

			assert.strictEqual(usage.services.length, 1)
			const zone = usage.services[0]!
			assert.strictEqual(zone.totalRequests, 150)
			assert.strictEqual(zone.totalDatapoints, 34)
			assert.strictEqual(zone.buckets.length, 2)
			assert.strictEqual(zone.buckets[0]?.datapoints, 24)
			assert.strictEqual(zone.buckets[0]?.requests, 100)
			assert.strictEqual(usage.totalRequests, 150)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage returns an empty window when not connected", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = { rows: [], calls: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const service = yield* CloudflareAnalyticsService
			const usage = yield* service.getUsage(ORG)
			assert.strictEqual(usage.totalRequests, 0)
			assert.strictEqual(usage.previousTotalRequests, 0)
			assert.strictEqual(usage.firewallBlockedEvents, 0)
			assert.strictEqual(usage.services.length, 0)
			assert.strictEqual(usage.windowEnd, T0)
			// Not connected → no warehouse query at all.
			assert.strictEqual(queryStub.calls.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})
})
