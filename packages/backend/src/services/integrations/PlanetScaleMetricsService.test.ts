import { afterEach, assert, describe, it } from "@effect/vitest"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { ConfigProvider, Effect, Exit, Layer, Schema, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleMetricsService } from "./PlanetScaleMetricsService"
import { PlanetScaleService } from "./PlanetScaleService"
import { PlanetScaleWebhookService } from "./PlanetScaleWebhookService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch
// `FetchHttpClient` keeps the first `fetch` it sees, so every test goes through one dispatcher.
let currentFetch: typeof fetch = originalFetch
const dispatchFetch = ((input: string | URL | Request, init?: RequestInit) =>
	currentFetch(input, init)) as typeof fetch

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.maple.test",
			PLANETSCALE_OAUTH_CLIENT_ID: "ps-client-id",
			PLANETSCALE_OAUTH_CLIENT_SECRET: "ps-client-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const oauthLive = PlanetScaleOAuthService.layer
	const discoveryLive = Layer.effect(PlanetScaleDiscoveryService, PlanetScaleDiscoveryService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(oauthLive),
	)
	const webhooksLive = Layer.effect(PlanetScaleWebhookService, PlanetScaleWebhookService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(oauthLive),
	)
	const scrapeTargetsLive = Layer.effect(ScrapeTargetsService, ScrapeTargetsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(discoveryLive, oauthLive, SupabaseOAuthService.layer)),
	)
	return Layer.mergeAll(
		Layer.effect(PlanetScaleMetricsService, PlanetScaleMetricsService.make).pipe(
			Layer.provide(Layer.mergeAll(FetchHttpClient.layer, OrgIngestKeysService.layer, oauthLive)),
		),
		Layer.effect(PlanetScaleService, PlanetScaleService.make).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(Layer.mergeAll(webhooksLive, oauthLive)),
		),
		Layer.effect(PlanetScaleConnectionService, PlanetScaleConnectionService.make).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(Layer.mergeAll(scrapeTargetsLive, discoveryLive, webhooksLive, oauthLive)),
		),
		oauthLive,
	).pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(makeConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

interface OtlpPayload {
	readonly resourceMetrics: ReadonlyArray<{
		readonly scopeMetrics: ReadonlyArray<{
			readonly metrics: ReadonlyArray<{
				readonly name: string
				readonly gauge?: {
					readonly dataPoints: ReadonlyArray<{
						readonly timeUnixNano: string
						readonly asDouble: number
						readonly attributes: ReadonlyArray<{
							readonly key: string
							readonly value: { readonly stringValue: string }
						}>
					}>
				}
			}>
		}>
	}>
}

/**
 * PlanetScale's management API with one database and its branches, a metrics endpoint that
 * answers one point per minute of the requested window, and an ingest gateway that records
 * what it receives.
 */
const fakePlanetScale = (
	options: { readonly ingestStatus?: number; readonly failBranches?: ReadonlyArray<string> } = {},
) => {
	const metricRequests: Array<{
		readonly branch: string
		readonly metrics: string | null
		readonly from: string | null
	}> = []
	const ingested: Array<OtlpPayload> = []
	globalThis.fetch = dispatchFetch
	currentFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		const url = new URL(request.url)
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
		if (url.hostname === "ingest.maple.test") {
			ingested.push((await request.json()) as OtlpPayload)
			return new Response(null, { status: options.ingestStatus ?? 200 })
		}
		if (url.pathname.endsWith("/oauth/token")) {
			return json({
				access_token: "ps-access-token",
				refresh_token: "ps-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "read_databases read_branches",
			})
		}
		if (url.pathname === "/v1/user") return json({ id: "psuser_1" })
		if (url.pathname === "/v1/organizations") return json({ data: [{ id: "psorg_1", name: "acme" }] })
		const metrics = url.pathname.match(/\/branches\/([^/]+)\/metrics$/)
		if (metrics) {
			const branch = decodeURIComponent(metrics[1]!)
			metricRequests.push({
				branch,
				metrics: url.searchParams.get("metrics"),
				from: url.searchParams.get("from"),
			})
			if (options.failBranches?.includes(branch)) return json({ code: "internal" }, 500)
			const from = Date.parse(url.searchParams.get("from") ?? "") / 1000
			const to = Date.parse(url.searchParams.get("to") ?? "") / 1000
			const points = Array.from({ length: (to - from) / 60 + 1 }, (_, index) => [
				from + index * 60,
				12.5,
			])
			return json({
				type: "MetricSeries",
				series: [{ metric: "planetscale_pods_cpu_util_percentages", label: "CPU usage", points }],
			})
		}
		if (url.pathname.endsWith("/databases/ledger/branches")) {
			return json({
				data: [
					{ id: "br_main", name: "main", production: true, ready: true },
					{ id: "br_pr", name: "pr-12", ready: true },
					{ id: "br_new", name: "fresh", ready: false },
				],
			})
		}
		if (/\/(deploy-requests|webhooks)$/.test(url.pathname)) return json({ data: [] })
		if (url.pathname.endsWith("/databases")) {
			return json({ data: [{ id: "db_1", name: "ledger", kind: "postgresql" }] })
		}
		return json([])
	}) as typeof fetch
	return { metricRequests, ingested }
}

const connectAndLoadInventory = (excludeBranches: ReadonlyArray<string> = []) =>
	Effect.gen(function* () {
		// The poller reads minutes behind now; start the test clock somewhere real.
		yield* TestClock.setTime(Date.parse("2026-10-24T00:00:30.000Z"))
		const oauth = yield* PlanetScaleOAuthService
		const { state } = yield* oauth.startConnect(asOrgId("org_1"), asUserId("user_1"), {
			callbackUrl: "https://api.maple.test/api/integrations/planetscale/callback",
		})
		yield* oauth.completeConnect("auth-code", state, {
			orgId: asOrgId("org_1"),
			userId: asUserId("user_1"),
		})
		yield* (yield* PlanetScaleConnectionService).finalizeOrgSelection(asOrgId("org_1"), {
			organization: "acme",
			excludeBranches,
		})
		yield* (yield* PlanetScaleService).pollAllOrgs()
	})

const cpuPoints = (payloads: ReadonlyArray<OtlpPayload>) =>
	payloads.flatMap((payload) =>
		payload.resourceMetrics.flatMap((resource) =>
			resource.scopeMetrics.flatMap((scope) =>
				scope.metrics
					.filter((metric) => metric.name === "planetscale_pods_cpu_util_percentages")
					.flatMap((metric) =>
						(metric.gauge?.dataPoints ?? []).map((point) => ({ time: point.timeUnixNano })),
					),
			),
		),
	)

const ingestedCpu = (payloads: ReadonlyArray<OtlpPayload>) =>
	payloads.flatMap((payload) =>
		payload.resourceMetrics.flatMap((resource) =>
			resource.scopeMetrics.flatMap((scope) =>
				scope.metrics
					.filter((metric) => metric.name === "planetscale_pods_cpu_util_percentages")
					.flatMap((metric) =>
						(metric.gauge?.dataPoints ?? []).map(
							(point) =>
								point.attributes.find(
									(attribute) => attribute.key === "planetscale_branch_name",
								)?.value.stringValue,
						),
					),
			),
		),
	)

describe("PlanetScaleMetricsService", () => {
	it.effect("polls every ready branch through the filters and reports the poll on the status", () => {
		const testDb = createTestDb(trackedDbs)
		const api = fakePlanetScale()
		return Effect.gen(function* () {
			yield* connectAndLoadInventory(["pr-*"])
			const summary = yield* (yield* PlanetScaleMetricsService).pollAll()

			assert.deepStrictEqual(
				api.metricRequests.map((request) => request.branch),
				["main"],
			)
			// One comma list: PlanetScale keeps only the last of repeated `metrics=` parameters.
			assert.include(api.metricRequests[0]?.metrics ?? "", "planetscale_pods_cpu_util_percentages,")
			// The first window is the ten minutes ending two minutes ago, one point each.
			assert.lengthOf(ingestedCpu(api.ingested), 11)
			assert.strictEqual(summary.rowsIngested, 11)

			const status = yield* (yield* PlanetScaleConnectionService).getStatus(asOrgId("org_1"))
			assert.strictEqual(status.metricsAuth, "api")
			assert.isNotNull(status.apiMetrics?.lastPolledAt ?? null)
			assert.isNull(status.apiMetrics?.lastError ?? null)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("leaves a connection that scrapes with a service token to Prometheus", () => {
		const testDb = createTestDb(trackedDbs)
		const api = fakePlanetScale()
		return Effect.gen(function* () {
			yield* connectAndLoadInventory()
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE scrape_targets SET auth_type = 'token', auth_credentials_ciphertext = 'x',
					 auth_credentials_iv = 'x', auth_credentials_tag = 'x', enabled = true WHERE org_id = 'org_1'`,
				),
			)
			yield* (yield* PlanetScaleMetricsService).pollAll()

			assert.lengthOf(api.metricRequests, 0)
			const status = yield* (yield* PlanetScaleConnectionService).getStatus(asOrgId("org_1"))
			assert.strictEqual(status.metricsAuth, "service_token")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps the window when the ingest gateway refuses it", () => {
		const testDb = createTestDb(trackedDbs)
		const api = fakePlanetScale({ ingestStatus: 503 })
		return Effect.gen(function* () {
			yield* connectAndLoadInventory(["pr-*"])
			yield* (yield* PlanetScaleMetricsService).pollAll()

			const state = yield* Effect.promise(() =>
				queryFirstRow<{ watermark_at: Date | null; last_error: string | null }>(
					testDb,
					`SELECT watermark_at, last_error FROM planetscale_poll_state WHERE org_id = 'org_1' AND dataset = 'metrics'`,
				),
			)
			assert.isNull(state?.watermark_at ?? null)
			assert.isNotNull(state?.last_error ?? null)
			assert.lengthOf(api.ingested, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("records a plan-limit refusal on the branch without failing its poll span", () => {
		const testDb = createTestDb(trackedDbs)
		const api = fakePlanetScale({ ingestStatus: 402 })
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		return Effect.gen(function* () {
			yield* connectAndLoadInventory(["pr-*"])
			yield* (yield* PlanetScaleMetricsService)
				.pollAll()
				.pipe(Effect.provideService(Tracer.Tracer, tracer))

			const state = yield* Effect.promise(() =>
				queryFirstRow<{ watermark_at: Date | null; last_error: string | null }>(
					testDb,
					`SELECT watermark_at, last_error FROM planetscale_poll_state WHERE org_id = 'org_1' AND dataset = 'metrics'`,
				),
			)
			assert.isNull(state?.watermark_at ?? null)
			assert.include(state?.last_error ?? "", "402")
			assert.lengthOf(api.ingested, 1)
			const polls = spans.filter((span) => span.name === "PlanetScaleMetricsService.pollBranch")
			assert.deepStrictEqual(
				polls.map((span) => [
					span.status._tag === "Ended" && Exit.isSuccess(span.status.exit),
					span.attributes.get("maple.ingest.outcome"),
				]),
				[[true, "refused"]],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("pauses an older connection's OAuth scrape target that Prometheus keeps rejecting", () => {
		const testDb = createTestDb(trackedDbs)
		fakePlanetScale()
		return Effect.gen(function* () {
			yield* connectAndLoadInventory()
			yield* Effect.promise(() =>
				executeSql(testDb, `UPDATE scrape_targets SET enabled = true WHERE org_id = 'org_1'`),
			)
			yield* (yield* PlanetScaleMetricsService).pollAll()

			const target = yield* Effect.promise(() =>
				queryFirstRow<{ enabled: boolean }>(
					testDb,
					`SELECT enabled FROM scrape_targets WHERE org_id = 'org_1'`,
				),
			)
			assert.isFalse(target?.enabled ?? true)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("continues each branch from its watermark on the next tick, without repeating a minute", () => {
		const testDb = createTestDb(trackedDbs)
		const api = fakePlanetScale()
		return Effect.gen(function* () {
			yield* connectAndLoadInventory(["pr-*"])
			const metrics = yield* PlanetScaleMetricsService
			yield* metrics.pollAll()
			yield* TestClock.adjust("5 minutes")
			yield* metrics.pollAll()

			const times = cpuPoints(api.ingested).map((point) => point.time)
			assert.lengthOf(times, 11 + 5)
			assert.strictEqual(new Set(times).size, times.length)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("lets one failing branch retry its window while the others move on", () => {
		const testDb = createTestDb(trackedDbs)
		const api = fakePlanetScale({ failBranches: ["pr-12"] })
		return Effect.gen(function* () {
			yield* connectAndLoadInventory()
			const metrics = yield* PlanetScaleMetricsService
			const summary = yield* metrics.pollAll()

			assert.lengthOf(cpuPoints(api.ingested), 11)
			assert.strictEqual(summary.failures, 1)
			const status = yield* (yield* PlanetScaleConnectionService).getStatus(asOrgId("org_1"))
			assert.include(status.apiMetrics?.lastError ?? "", "1 of 2 branches failed")
			assert.isNotNull(status.apiMetrics?.lastPolledAt ?? null)

			// The failed branch asks for its first window again; main asks only for what is new.
			yield* TestClock.adjust("5 minutes")
			yield* metrics.pollAll()
			const windows = api.metricRequests.slice(-2).map((request) => [request.branch, request.from])
			assert.sameDeepMembers(windows, [
				["main", "2026-10-23T23:59:00.000Z"],
				["pr-12", "2026-10-23T23:53:00.000Z"],
			])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
