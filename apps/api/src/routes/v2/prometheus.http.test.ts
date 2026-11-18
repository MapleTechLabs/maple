import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId, WarehouseQueryError } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { PromqlQueryService } from "@maple/backend/services/promql/PromqlQueryService"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { ApiV2RateLimiterAllowAllLayer, makeWarehouseServiceStub } from "./v2-test-support"
import { HttpV2PrometheusLive } from "./prometheus.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const BASE = "/v2/metrics/prometheus/api/v1"

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3490",
			MCP_PORT: "3491",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

/** The metric catalog holds one counter; any other read is empty. Selector reads are size-bounded. */
const catalogWarehouse = makeWarehouseServiceStub({
	compiledQuery: (_tenant, compiled) => {
		const query = compiledQueryOf(compiled)
		const catalog = Str.includes("FROM metric_catalog")(query.sql)
		return query.decodeRows(
			catalog
				? [
						{
							metricName: "http.requests",
							metricType: "sum",
							unit: "",
							isMonotonic: 1,
							description: "Requests",
						},
					]
				: [],
		)
	},
	compiledQueryBounded: (_tenant, compiled) => {
		const query = compiledQueryOf(compiled)
		const catalog = Str.includes("FROM metric_catalog")(query.sql)
		// The bounded read's error union has no decode failure; the fixture rows always decode.
		return query
			.decodeRows(
				catalog
					? [
							{
								metricName: "http.requests",
								metricType: "sum",
								unit: "",
								isMonotonic: 1,
								description: "Requests",
							},
						]
					: [],
			)
			.pipe(Effect.orDie)
	},
})

const failingWarehouse = makeWarehouseServiceStub({
	compiledQuery: () =>
		Effect.fail(new WarehouseQueryError({ message: "SECRET_DIAGNOSTIC", pipeName: "stub" })),
})

const makeHarness = (warehouse: WarehouseQueryServiceApi = catalogWarehouse) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(ApiKeysService.layer, AuthService.layer).pipe(
		Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)),
	)
	const routes = HttpApiBuilder.layer(HttpApi.make("MapleApiV2").add(MapleApiV2.groups.prometheus)).pipe(
		Layer.provide(HttpV2PrometheusLive),
		Layer.provide(
			Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
				Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
			),
		),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)
	const org = Schema.decodeSync(OrgId)("org_prometheus_e2e")
	const user = Schema.decodeSync(UserId)("user_prometheus_e2e")
	const bootstrapKey = (scopes?: ReadonlyArray<string>, roles?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(org, user, {
					name: "prometheus-test",
					scopes,
					...(roles === undefined
						? undefined
						: { metadataJson: { source: "maple_cli", roles, deviceName: "laptop" } }),
				})
			}),
		)
	const send = async (token: string, path: string, form?: URLSearchParams) => {
		const response = await handler(
			new Request(`http://maple.test${BASE}${path}`, {
				method: form === undefined ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${token}`,
					...(form === undefined
						? undefined
						: { "content-type": "application/x-www-form-urlencoded" }),
				},
				body: form?.toString(),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}
	return {
		bootstrapKey,
		send,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

const T = Date.UTC(2026, 6, 15, 12) / 1000

describe("v2 Prometheus query API", () => {
	it("answers an instant query at a Unix-seconds time with Go-formatted values", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const vector = await harness.send(key.secret, `/query?query=vector(1e21)&time=${T}.5`)
		expect(vector).toEqual({
			status: 200,
			body: {
				status: "success",
				data: {
					resultType: "vector",
					result: [{ metric: {}, value: [T + 0.5, "1000000000000000000000"] }],
				},
			},
		})
		for (const [query, value] of [
			["1/0", "+Inf"],
			["-1/0", "-Inf"],
			["0/0", "NaN"],
			["0.1+0.2", "0.30000000000000004"],
			["1e-7", "0.0000001"],
		] as const) {
			const scalar = await harness.send(
				key.secret,
				`/query?query=${encodeURIComponent(query)}&time=${T}`,
			)
			expect(scalar.body).toEqual({
				status: "success",
				data: { resultType: "scalar", result: [T, value] },
			})
		}
		await harness.dispose()
	})

	it("answers a one-point matrix for a range whose start equals its end", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const range = await harness.send(
			key.secret,
			`/query_range?query=vector(2)&start=${T}&end=${T}&step=30s`,
		)
		expect(range.body).toEqual({
			status: "success",
			data: { resultType: "matrix", result: [{ metric: {}, values: [[T, "2"]] }] },
		})
		await harness.dispose()
	})

	it("applies limit to a query's series and says so in warnings", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const two = encodeURIComponent(
			'label_replace(vector(1), "a", "x", "", "") or label_replace(vector(2), "a", "y", "", "")',
		)
		const limited = await harness.send(key.secret, `/query?query=${two}&time=${T}&limit=1`)
		expect(limited.body).toEqual({
			status: "success",
			data: { resultType: "vector", result: [{ metric: { a: "x" }, value: [T, "1"] }] },
			warnings: ["results truncated due to limit"],
		})
		const unlimited = await harness.send(key.secret, `/query?query=${two}&time=${T}&limit=0`)
		expect(unlimited.body).toMatchObject({ data: { result: [{}, {}] } })
		await harness.dispose()
	})

	it("answers a range query POSTed as a form with RFC3339 bounds and a duration step", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const form = new URLSearchParams({
			query: "vector(2)",
			start: "2026-07-15T12:00:00Z",
			end: "2026-07-15T12:01:00Z",
			step: "30s",
		})
		const range = await harness.send(key.secret, "/query_range", form)
		expect(range).toEqual({
			status: 200,
			body: {
				status: "success",
				data: {
					resultType: "matrix",
					result: [
						{
							metric: {},
							values: [
								[T, "2"],
								[T + 30, "2"],
								[T + 60, "2"],
							],
						},
					],
				},
			},
		})
		const floatStep = await harness.send(
			key.secret,
			`/query_range?query=vector(1)&start=${T}&end=${T + 1}&step=0.5`,
		)
		expect(floatStep.body).toMatchObject({
			data: {
				result: [
					{
						values: [
							[T, "1"],
							[T + 0.5, "1"],
							[T + 1, "1"],
						],
					},
				],
			},
		})
		await harness.dispose()
	})

	it("reports errors in Prometheus' envelope with its status codes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const syntax = await harness.send(key.secret, `/query?query=${encodeURIComponent("sum(")}&time=${T}`)
		expect(syntax.status).toBe(400)
		expect(syntax.body).toMatchObject({ status: "error", errorType: "bad_data" })
		const badTime = await harness.send(key.secret, "/query?query=1&time=yesterday")
		expect(badTime).toEqual({
			status: 400,
			body: {
				status: "error",
				errorType: "bad_data",
				error: 'invalid parameter "time": cannot parse "yesterday" to a valid timestamp',
			},
		})
		const badStep = await harness.send(
			key.secret,
			`/query_range?query=1&start=${T}&end=${T + 60}&step=soon`,
		)
		expect(badStep.body).toMatchObject({
			error: 'invalid parameter "step": cannot parse "soon" to a valid duration',
		})
		const execution = await harness.send(
			key.secret,
			`/query?query=${encodeURIComponent("topk(NaN, vector(1))")}&time=${T}`,
		)
		expect(execution.status).toBe(422)
		expect(execution.body).toMatchObject({ status: "error", errorType: "execution" })
		await harness.dispose()
	})

	it("refuses a range vector in a range query, an over-long query and an over-wide range as bad_data", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const matrix = await harness.send(
			key.secret,
			`/query_range?query=${encodeURIComponent("up[5m]")}&start=${T}&end=${T + 60}&step=15s`,
		)
		expect(matrix.status).toBe(400)
		expect(matrix.body).toMatchObject({ status: "error", errorType: "bad_data" })
		const long = await harness.send(
			key.secret,
			"/query",
			new URLSearchParams({ query: Str.repeat(5001)("1+") + "1" }),
		)
		expect(long.status).toBe(400)
		expect(long.body).toMatchObject({ errorType: "bad_data", error: expect.stringMatching(/"query"/) })
		const wide = `start=${T - 40 * 86_400}&end=${T}`
		for (const path of [
			`/query_range?query=1&${wide}&step=1h`,
			`/series?match[]=up&${wide}`,
			`/labels?${wide}`,
			`/label/job/values?${wide}`,
			`/metadata?${wide}`,
		]) {
			const refused = await harness.send(key.secret, path)
			expect(refused.status).toBe(400)
			expect(refused.body).toMatchObject({
				errorType: "bad_data",
				error: "the time range exceeds the maximum of 32 days",
			})
		}
		await harness.dispose()
	})

	it("reports a warehouse failure as unavailable without its diagnostic", async () => {
		const harness = makeHarness(failingWarehouse)
		const key = await harness.bootstrapKey(["metrics:read"])
		const failed = await harness.send(key.secret, `/query?query=up&time=${T}`)
		expect(failed.status).toBe(503)
		expect(failed.body).toMatchObject({ status: "error", errorType: "unavailable" })
		expect(JSON.stringify(failed.body)).not.toContain("SECRET_DIAGNOSTIC")
		await harness.dispose()
	})
})

describe("v2 Prometheus discovery API", () => {
	it("lists metric names, label names and build info the way Grafana reads them", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const window = `start=${T - 3600}&end=${T}`
		expect((await harness.send(key.secret, `/label/__name__/values?${window}`)).body).toEqual({
			status: "success",
			data: ["http_requests_total"],
		})
		expect((await harness.send(key.secret, "/labels", new URLSearchParams(window))).body).toEqual({
			status: "success",
			data: ["__name__", "instance", "job"],
		})
		// The earliest end a Date holds: the default hour before it must not step outside the range.
		const edge = await harness.send(key.secret, "/labels", new URLSearchParams({ end: "-8640000000000" }))
		expect(edge.status).not.toBe(500)
		// Metadata is keyed by the Prometheus family name, with the OTel description as help.
		expect((await harness.send(key.secret, `/metadata?${window}`)).body).toEqual({
			status: "success",
			data: { http_requests_total: [{ type: "counter", help: "Requests", unit: "" }] },
		})
		const buildInfo = await harness.send(key.secret, "/status/buildinfo")
		expect(buildInfo.body).toMatchObject({ data: { version: "3.5.0", vendor: "Maple" } })
		expect(
			(await harness.send(key.secret, "/query_exemplars", new URLSearchParams({ query: "up" }))).body,
		).toEqual({
			status: "success",
			data: [],
		})
		await harness.dispose()
	})

	it("reads an empty time, start or end as absent, as Prometheus does", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const instant = await harness.send(key.secret, "/query?query=vector(1)&time=")
		expect(instant.body).toMatchObject({ status: "success", data: { resultType: "vector" } })
		expect((await harness.send(key.secret, "/labels?start=&end=")).body).toMatchObject({
			status: "success",
		})
		const form = new URLSearchParams([
			["match[]", "http_requests_total"],
			["start", ""],
			["end", ""],
		])
		expect((await harness.send(key.secret, "/series", form)).body).toMatchObject({ status: "success" })
		await harness.dispose()
	})

	it("reads repeated match[] parameters and refuses a series call without one", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["metrics:read"])
		const form = new URLSearchParams([
			["match[]", "http_requests_total"],
			["match[]", 'up{job="api"}'],
			["start", String(T - 60)],
			["end", String(T)],
		])
		expect((await harness.send(key.secret, "/series", form)).body).toEqual({
			status: "success",
			data: [],
		})
		// The same parameter on a GET's query string: one value, and every repeated value.
		const one = new URLSearchParams([["match[]", "http_requests_total"]])
		expect((await harness.send(key.secret, `/series?${one}`)).body).toEqual({
			status: "success",
			data: [],
		})
		const many = new URLSearchParams(Array.from({ length: 21 }, (_, i) => ["match[]", `up{i="${i}"}`]))
		const capped = await harness.send(key.secret, `/series?${many}`)
		expect(capped.body).toEqual({
			status: "error",
			errorType: "bad_data",
			error: "match[] reads more than 20 selectors",
		})
		const missing = await harness.send(key.secret, "/series")
		expect(missing.status).toBe(400)
		expect(missing.body).toEqual({
			status: "error",
			errorType: "bad_data",
			error: "no match[] parameter provided",
		})
		await harness.dispose()
	})

	it("refuses a key without metrics:read on GET and form POST, and serves an analyst's POST", async () => {
		const harness = makeHarness()
		const traces = await harness.bootstrapKey(["traces:read"])
		expect((await harness.send(traces.secret, `/query?query=1&time=${T}`)).status).toBe(403)
		const form = new URLSearchParams({ query: "1", time: String(T) })
		expect((await harness.send(traces.secret, "/query", form)).status).toBe(403)
		const analyst = await harness.bootstrapKey(undefined, ["org:analyst"])
		const answered = await harness.send(analyst.secret, "/query", form)
		expect(answered.status).toBe(200)
		expect(answered.body).toEqual({ status: "success", data: { resultType: "scalar", result: [T, "1"] } })
		await harness.dispose()
	})
})
