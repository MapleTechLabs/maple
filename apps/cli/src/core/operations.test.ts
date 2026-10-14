import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Cause, Effect, Exit, Layer, Option, Tracer } from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
import { CliNotFoundError, LocalServerUnreachableError, ReadOnlyQueryError } from "../lib/errors"
import { assertKnownService } from "../commands/services"
import { Mode } from "./mode"
import { rawQuery, serviceMap } from "./operations"
import { WarehouseExecutorFromMode } from "./warehouse"

const RANGE = { startTime: "2026-08-15 12:00:00", endTime: "2026-08-15 13:00:00" }

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("rawQuery instrumentation", () => {
	it.effect("emits the canonical chDB Client span", () =>
		Effect.gen(function* () {
			// SAFETY: this focused fetch stub returns the only response shape exercised by the query.
			const request = (async () =>
				new Response(JSON.stringify([{ value: 1 }]), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch
			const { spans, tracer } = makeRecordingTracer()
			const modeLayer = Layer.succeed(Mode, {
				resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
			})
			const httpLayer = FetchHttpClient.layer.pipe(
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)),
			)

			const { rows } = yield* rawQuery({ sql: "SELECT 1", range: RANGE }).pipe(
				Effect.provide(Layer.merge(modeLayer, httpLayer)),
				Effect.withTracer(tracer),
			)

			assert.deepStrictEqual(rows, [{ value: 1 }])
			const span = spans.find((candidate) => candidate.name === "WarehouseExecutor.rawQuery")
			assert.ok(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("db.system.name"), "clickhouse")
			assert.strictEqual(span.attributes.get("peer.service"), "chdb")
			assert.strictEqual(span.attributes.get("query.context"), "cli.rawQuery")
			assert.strictEqual(span.attributes.get("result.rowCount"), 1)
			assert.strictEqual(typeof span.attributes.get("db.duration_ms"), "number")
		}),
	)
})

describe("rawQuery failures", () => {
	const modeLayer = Layer.succeed(Mode, {
		resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
	})
	const run = (
		respond: (
			request: HttpClientRequest.HttpClientRequest,
		) => Effect.Effect<Response, HttpClientError.HttpClientError>,
	) =>
		Effect.runPromise(
			Effect.flip(rawQuery({ sql: "CREATE TABLE t (a Int8) ENGINE = Memory", range: RANGE })).pipe(
				Effect.provide(
					Layer.merge(
						modeLayer,
						Layer.succeed(
							HttpClient.HttpClient,
							HttpClient.make((request) =>
								Effect.map(respond(request), (response) =>
									HttpClientResponse.fromWeb(request, response),
								),
							),
						),
					),
				),
			),
		)

	// The server refuses writes; the user sees why, not a warehouse error.
	it("maps the read-only refusal to its reason", async () => {
		const error = await run(() =>
			Effect.succeed(new Response("read-only query endpoint: CREATE is not allowed", { status: 400 })),
		)
		assert.ok(error instanceof ReadOnlyQueryError)
		assert.equal(error.message, "maple query is read-only: CREATE is not allowed")
	})

	it("names the URL it could not reach", async () => {
		const error = await run((request) =>
			Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({
						request,
						description: "connection refused",
					}),
				}),
			),
		)
		assert.ok(error instanceof LocalServerUnreachableError)
		assert.match(error.message, /http:\/\/127\.0\.0\.1:4318/)
		assert.match(error.hint ?? "", /MAPLE_LOCAL_URL/)
	})
})

describe("rawQuery macros", () => {
	const modeLayer = Layer.succeed(Mode, {
		resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
	})
	const sent = (sql: string) =>
		Effect.runPromise(
			Effect.gen(function* () {
				let body = ""
				yield* rawQuery({ sql, range: RANGE }).pipe(
					Effect.provide(
						Layer.merge(
							modeLayer,
							Layer.succeed(
								HttpClient.HttpClient,
								HttpClient.make((request) =>
									Effect.sync(() => {
										body =
											request.body._tag === "Uint8Array"
												? new TextDecoder().decode(request.body.body)
												: ""
										return HttpClientResponse.fromWeb(
											request,
											new Response("[]", { status: 200 }),
										)
									}),
								),
							),
						),
					),
				)
				return body
			}),
		)

	// The same SQL a workspace runs, so a query can move between the two modes unchanged.
	it("expands the workspace macros with the local tenant and the window", async () => {
		const body = await sent("SELECT count() FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)")
		assert.match(body, /OrgId = 'local'/)
		assert.match(body, /Timestamp >= toDateTime\('2026-08-15 12:00:00'\)/)
		assert.doesNotMatch(body, /\$__/)
	})

	it("leaves plain SQL exactly as written", async () => {
		const body = await sent("SELECT 1")
		assert.match(body, /SELECT 1/)
		assert.doesNotMatch(body, /maple_raw_sql_limited/)
	})
})

describe("assertKnownService", () => {
	const modeLayer = Layer.succeed(Mode, {
		resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
	})
	const overviewRow = (serviceName: string) => ({
		serviceName,
		serviceNamespace: "",
		environment: "production",
		throughput: 10,
		errorCount: 0,
		estimatedErrorCount: 0,
		spanCount: 10,
		p50LatencyMs: 1,
		p95LatencyMs: 2,
		p99LatencyMs: 3,
		estimatedSpanCount: 10,
		firstSeen: "2026-08-15 12:00:00",
		commits: [],
	})
	// A local server whose service list is one full page that never reaches
	// `checkout`, the way a busy workspace's capped overview does.
	const run = (presentSpans: number) =>
		Effect.runPromise(
			Effect.exit(assertKnownService("checkout", RANGE, "the last hour")).pipe(
				Effect.provide(
					WarehouseExecutorFromMode.pipe(
						Layer.provideMerge(
							Layer.merge(
								modeLayer,
								Layer.succeed(
									HttpClient.HttpClient,
									HttpClient.make((request) =>
										Effect.sync(() => {
											const body =
												request.body._tag === "Uint8Array"
													? new TextDecoder().decode(request.body.body)
													: ""
											const rows = body.includes("throughput")
												? [overviewRow("api"), overviewRow("worker")]
												: body.includes("spanCount")
													? [
															{
																spanCount: body.includes("'checkout'")
																	? presentSpans
																	: 0,
															},
														]
													: []
											return HttpClientResponse.fromWeb(
												request,
												new Response(JSON.stringify(rows), { status: 200 }),
											)
										}),
									),
								),
							),
						),
					),
				),
			),
		)

	it("accepts a service with telemetry that the capped service list leaves out", async () => {
		const exit = await run(42)
		assert.ok(Exit.isSuccess(exit))
	})

	it("names the known services when the service has no telemetry", async () => {
		const exit = await run(0)
		assert.ok(Exit.isFailure(exit))
		const error = Cause.findErrorOption(exit.cause)
		assert.ok(Option.isSome(error) && error.value instanceof CliNotFoundError)
		assert.strictEqual(error.value.message, "no telemetry for 'checkout' in the last hour")
		assert.match(error.value.hint ?? "", /known services: (api, worker|worker, api)/)
	})
})

describe("serviceMap in local mode", () => {
	const EDGE = { callCount: 3, errorCount: 0, avgDurationMs: 10, maxDurationMs: 20, estimatedSpanCount: 3 }
	const STATS = { ...EDGE, p95DurationMs: 15 }

	/** Answers each query by the rollup it reads; records every SQL the server receives. */
	const run = (service?: string) =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			// SAFETY: this focused fetch stub returns the only response shape the queries read.
			const request = (async (_input: string | URL | Request, init?: RequestInit) => {
				const raw = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "{}"
				// SAFETY: the local executor always posts a `{ sql }` JSON body.
				const sql = (JSON.parse(raw) as { sql?: string }).sql ?? ""
				sqls.push(sql)
				const rows = sql.includes("service_map_db_edges_hourly")
					? [{ sourceService: "api", dbSystem: "postgresql", dbNamespace: "shop", ...STATS }]
					: sql.includes("service_external_edges_hourly")
						? [
								{
									sourceService: "api",
									targetType: "http",
									targetSystem: "",
									targetName: "api.stripe.com",
									...STATS,
								},
							]
						: [
								{ sourceService: "web", targetService: "api", ...EDGE },
								{ sourceService: "api", targetService: "billing", ...EDGE },
							]
				return new Response(JSON.stringify(rows), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}) as unknown as typeof fetch
			const modeLayer = Layer.succeed(Mode, {
				resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318" }),
			})
			const httpLayer = FetchHttpClient.layer.pipe(
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)),
			)
			const result = yield* serviceMap({ range: RANGE, service }).pipe(
				Effect.provide(
					WarehouseExecutorFromMode.pipe(Layer.provideMerge(Layer.merge(modeLayer, httpLayer))),
				),
			)
			return { result, sqls }
		})

	it.effect("lists databases org-wide and skips the per-service external query", () =>
		Effect.gen(function* () {
			const { result, sqls } = yield* run()
			assert.strictEqual(result.edges.length, 2)
			assert.deepStrictEqual(
				result.databases?.map((d) => `${d.sourceService} -> ${d.dbSystem}/${d.dbNamespace}`),
				["api -> postgresql/shop"],
			)
			assert.strictEqual(result.external, undefined)
			assert.ok(!sqls.some((sql) => sql.includes("service_external_edges_hourly")))
		}),
	)

	it.effect("scopes -s inside the query, both directions, with its databases and external calls", () =>
		Effect.gen(function* () {
			const { result, sqls } = yield* run("api")
			// Filtering a capped org-wide list would drop a quiet service's inbound edges.
			const edgesSql = sqls.find((sql) => sql.includes("service_map_edges_hourly"))
			assert.ok(edgesSql)
			assert.match(edgesSql, /SourceService = 'api' OR [\w.]*TargetService = 'api'/)
			assert.match(edgesSql, /p\.ServiceName = 'api' OR c\.ServiceName = 'api'/)
			assert.deepStrictEqual(
				result.edges.map((e) => `${e.sourceService} -> ${e.targetService}`),
				["web -> api", "api -> billing"],
			)
			assert.strictEqual(result.databases?.length, 1)
			assert.deepStrictEqual(
				result.external?.map((e) => `${e.targetType} ${e.targetName}`),
				["http api.stripe.com"],
			)
		}),
	)
})
