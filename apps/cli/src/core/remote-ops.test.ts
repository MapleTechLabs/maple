import { beforeEach, describe, expect, it } from "bun:test"
import { Arbitrary, Cause, Effect, Exit, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { V2LogSearchParams, V2TelemetryWindowQuery } from "@maple/domain/http/v2"
import { MAX_LIST_RANGE_SECONDS, timeWindowViolation } from "@maple/query-engine"
import { CliNotFoundError } from "../lib/errors"
import * as Remote from "./remote-ops"
import { resolveRangeChecked } from "./time"
import { makeV2Client, toV2Window } from "./v2-client"

// These tests exist because the endpoint this replaced broke silently.
//
// The old remote executor POSTed `{ pipe, params }` while the server contract
// had been renamed to `pipeName`. Every remote command failed payload decode
// for months, and the executor's test never noticed — it stubbed `fetch` and
// asserted only on the decoded response, never on the request it sent.
//
// So the rule here: assert the OUTBOUND request. URL, method, and body shape
// are the contract with the server, and they are what drifts.
//
// Run plain awaited tests because the recorder and responder are shared within
// this file. Supply the fetch stub through Effect's service context: a global
// replacement depends on whether another suite has already built an HTTP client.

interface CapturedRequest {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	readonly body: Record<string, unknown>
}

type StubResponse = Record<string, unknown>

const decodeCapturedBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

let requests: Array<CapturedRequest> = []
let responder: (url: string) => StubResponse = () => ({})

const fetchStub = Object.assign(
	async (input: string | URL | Request, init?: RequestInit) => {
		// Read through `Request` rather than poking at `init.body`: the HTTP client
		// may send a stream or a Uint8Array, and stringifying those yields garbage
		// instead of the payload we mean to assert on.
		const request =
			input instanceof Request && init === undefined
				? input
				: new Request(input instanceof Request ? input.url : String(input), init)
		const text = await request.clone().text()
		requests.push({
			url: request.url,
			method: request.method.toUpperCase(),
			authorization: request.headers.get("authorization"),
			body: text.length > 0 ? decodeCapturedBody(JSON.parse(text)) : {},
		})
		return new Response(JSON.stringify(responder(request.url)), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	},
	{ preconnect: globalThis.fetch.preconnect },
) satisfies typeof fetch

const stubV2 = (respond: (url: string) => StubResponse) => {
	responder = respond
	return requests
}

const RANGE = { startTime: "2026-08-15 12:00:00", endTime: "2026-08-15 13:00:00" }

const v2Client = makeV2Client("https://api.maple.test", "maple_ak_testtoken").pipe(
	Effect.provide(FetchHttpClient.layer),
	Effect.provideService(FetchHttpClient.Fetch, fetchStub),
)

const listEnvelope = (data: ReadonlyArray<unknown>) => ({
	object: "list",
	data,
	has_more: false,
	next_cursor: null,
})

beforeEach(() => {
	requests = []
	responder = () => listEnvelope([])
})

describe("remote-ops request shapes", () => {
	it("listServices GETs /v2/services with the window and a bearer token", async () => {
		const requests = stubV2(() => listEnvelope([]))
		await Effect.runPromise(Effect.flatMap(v2Client, (v2) => Remote.listServices(v2, { range: RANGE })))

		expect(requests).toHaveLength(1)
		const request = requests[0]!
		expect(request.method).toBe("GET")
		expect(request.authorization).toBe("Bearer maple_ak_testtoken")
		const url = new URL(request.url)
		expect(url.pathname).toBe("/v2/services")
		// The window must be ISO-8601 UTC; the CLI's own `Range` is
		// ClickHouse-style and the v2 `Timestamp` schema rejects it.
		expect(url.searchParams.get("start_time")).toBe("2026-08-15T12:00:00.000Z")
		expect(url.searchParams.get("end_time")).toBe("2026-08-15T13:00:00.000Z")
	})

	it("searchTraces POSTs /v2/traces/search scoped to root spans", async () => {
		const requests = stubV2(() => listEnvelope([]))
		await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) =>
				Remote.searchTraces(v2, { range: RANGE, service: "api", hasError: true, limit: 5 }),
			),
		)

		expect(requests).toHaveLength(1)
		const request = requests[0]!
		expect(request.method).toBe("POST")
		expect(new URL(request.url).pathname).toBe("/v2/traces/search")
		expect(request.body).toMatchObject({
			start_time: "2026-08-15T12:00:00.000Z",
			end_time: "2026-08-15T13:00:00.000Z",
			limit: 5,
			// Without span_scope the endpoint would return non-root spans and the
			// rows would no longer describe one trace each.
			filters: { span_scope: "root", service_name: "api", has_error: true },
		})
	})

	it("searchTraces refuses a span-name filter instead of silently searching roots", async () => {
		const requests = stubV2(() => listEnvelope([]))
		const exit = await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) =>
				Effect.exit(Remote.searchTraces(v2, { range: RANGE, spanName: "GET /checkout" })),
			),
		)

		expect(Exit.isFailure(exit)).toBe(true)
		// The point is that it never reached the network: a root-span answer to a
		// span-name query looks valid and is wrong.
		expect(requests).toHaveLength(0)
	})

	it("searchLogs refuses --offset rather than ignoring it", async () => {
		const requests = stubV2(() => listEnvelope([]))
		const exit = await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) =>
				Effect.exit(Remote.searchLogs(v2, { range: RANGE, offset: 40 })),
			),
		)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(requests).toHaveLength(0)
	})

	it("inspectTrace derives the log window from the trace's own bounds", async () => {
		const traceId = "7f3a4b5c6d7e8f901234567890abcdef"
		const requests = stubV2((url) =>
			url.includes("/logs/search")
				? listEnvelope([])
				: {
						id: traceId,
						object: "trace",
						start_time: "2026-08-15T12:30:00.000Z",
						end_time: "2026-08-15T12:30:02.000Z",
						duration_ms: 2000,
						span_count: 0,
						service_count: 0,
						truncated: false,
						spans: [],
					},
		)
		await Effect.runPromise(Effect.flatMap(v2Client, (v2) => Remote.inspectTrace(v2, { traceId })))

		expect(requests).toHaveLength(2)
		expect(new URL(requests[0]!.url).pathname).toBe(`/v2/traces/${traceId}`)
		// `maple trace <id>` takes no time flags, so the window has to come from
		// the trace itself — a wrong window here silently drops its logs.
		expect(requests[1]!.body).toMatchObject({
			start_time: "2026-08-15T12:30:00.000Z",
			end_time: "2026-08-15T12:30:02.000Z",
			filters: { trace_id: traceId },
		})
	})

	it("inspectTrace widens the log window when every span shares one instant", async () => {
		const traceId = "671403778c461093dbe435b41b677d18"
		const requests = stubV2((url) =>
			url.includes("/logs/search")
				? listEnvelope([])
				: {
						id: traceId,
						object: "trace",
						start_time: "2026-10-24T22:04:19.898Z",
						end_time: "2026-10-24T22:04:19.898Z",
						duration_ms: 0,
						span_count: 0,
						service_count: 0,
						truncated: false,
						spans: [],
					},
		)
		await Effect.runPromise(Effect.flatMap(v2Client, (v2) => Remote.inspectTrace(v2, { traceId })))

		// The logs search rejects `end_time == start_time` with invalid_time_range.
		expect(requests[1]!.body).toMatchObject({
			start_time: "2026-10-24T22:04:19.898Z",
			end_time: "2026-10-24T22:04:19.899Z",
		})
	})

	it("listMetrics returns local mode's column names, not the v2 wire names", async () => {
		stubV2(() =>
			listEnvelope([
				{
					object: "metric",
					name: "http.server.duration",
					type: "histogram",
					service_name: "api",
					description: "Request duration",
					unit: "ms",
					is_monotonic: false,
					data_point_count: 42,
					first_seen: "2026-08-15T12:00:00.000Z",
					last_seen: "2026-08-15T13:00:00.000Z",
				},
			]),
		)
		const rows = await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) => Remote.listMetrics(v2, { range: RANGE })),
		)

		// `maple metrics` prints the row's own keys, so a pass-through of the v2
		// resource renamed every column when the same command ran remotely.
		expect(rows[0]).toEqual({
			metricName: "http.server.duration",
			metricType: "histogram",
			serviceName: "api",
			metricDescription: "Request duration",
			metricUnit: "ms",
			dataPointCount: 42,
			firstSeen: "2026-08-15T12:00:00.000Z",
			lastSeen: "2026-08-15T13:00:00.000Z",
			isMonotonic: false,
		})
	})

	it("tracesTimeseries merges the per-aggregation series onto local mode's columns", async () => {
		const point = (value: number) => ({
			object: "trace_timeseries",
			aggregation: "count",
			start_time: "2026-08-15T12:00:00.000Z",
			end_time: "2026-08-15T13:00:00.000Z",
			bucket_seconds: 60,
			group_by: null,
			series: [{ group: null, points: [{ timestamp: "2026-08-15T12:00:00.000Z", value }] }],
		})
		let call = 0
		stubV2(() => point(++call))
		const rows = await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) => Remote.tracesTimeseries(v2, { range: RANGE })),
		)

		expect(rows).toHaveLength(1)
		expect(Object.keys(rows[0]!).sort()).toEqual(
			[
				"avgDuration",
				"bucket",
				"count",
				"errorRate",
				"groupName",
				"p50Duration",
				"p95Duration",
				"p99Duration",
			].sort(),
		)
	})
})

describe("inspectTrace not found", () => {
	it("turns a trace_not_found envelope into CliNotFoundError", async () => {
		const notFound = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							_tag: "@maple/http/v2/TraceNotFoundError",
							type: "not_found_error",
							code: "trace_not_found",
							title: "Trace not found",
							message: "No such trace.",
							retryable: false,
							recovery: "none",
						},
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				),
			{ preconnect: globalThis.fetch.preconnect },
		) satisfies typeof fetch
		const client = makeV2Client("https://api.maple.test", "maple_ak_testtoken").pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, notFound),
		)
		const exit = await Effect.runPromise(
			Effect.flatMap(client, (v2) =>
				Effect.exit(Remote.inspectTrace(v2, { traceId: "0af7651916cd43dd8448eb211c80319c" })),
			),
		)
		expect(Exit.isFailure(exit)).toBe(true)
		const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
		const error = Option.getOrUndefined(failure)
		expect(error).toBeInstanceOf(CliNotFoundError)
		// The hint is what turns a dead end into a next step.
		expect(error).toMatchObject({ hint: expect.stringContaining("maple traces") })
	})
})

describe("serviceHasTelemetry", () => {
	const clientAnswering = (status: number, body: unknown) => {
		const urls: Array<string> = []
		const respond = Object.assign(
			async (input: string | URL | Request) => {
				urls.push(input instanceof Request ? input.url : String(input))
				return new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				})
			},
			{ preconnect: globalThis.fetch.preconnect },
		) satisfies typeof fetch
		const client = makeV2Client("https://api.maple.test", "maple_ak_testtoken").pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, respond),
		)
		return { urls, client }
	}
	const check = (status: number, body: unknown) => {
		const { urls, client } = clientAnswering(status, body)
		return Effect.runPromise(
			Effect.flatMap(client, (v2) =>
				Remote.serviceHasTelemetry(v2, { service: "checkout", range: RANGE }),
			),
		).then((present) => ({ present, urls }))
	}

	it("looks the service up by name rather than in a list page", async () => {
		const { present, urls } = await check(200, {
			object: "service",
			name: "checkout",
			service_namespaces: [],
			deployment_environments: ["production"],
			throughput: 5,
			traced_throughput: 5,
			span_count: 5,
			error_count: 0,
			error_rate: 0,
			p50_latency_ms: 1,
			p95_latency_ms: 2,
			p99_latency_ms: 3,
			has_sampling: false,
			sampling_weight: 1,
		})
		expect(present).toBe(true)
		const url = new URL(urls[0]!)
		expect(url.pathname).toBe("/v2/services/checkout")
		expect(url.searchParams.get("start_time")).toBe("2026-08-15T12:00:00.000Z")
	})

	it("reads service_not_found as no telemetry", async () => {
		const { present } = await check(404, {
			error: {
				_tag: "@maple/http/v2/ServiceNotFoundError",
				type: "not_found_error",
				code: "service_not_found",
				title: "Service not found",
				message: "No such service.",
				retryable: false,
				recovery: "none",
			},
		})
		expect(present).toBe(false)
	})
})

// Property tests for windows the CLI builds itself. The server refuses an empty
// window and one wider than the endpoint's cap; these generate inputs skewed
// toward exactly those edges and check every window against the server's rule.
describe("remote-ops window properties", () => {
	const int = (minimum: number, maximum: number) =>
		Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
	const pick = <const L extends ReadonlyArray<string>>(literals: L) =>
		Arbitrary.schema(Schema.Literals(literals))

	const DAY_MS = 86_400_000
	const SEARCH_CAP_MS = MAX_LIST_RANGE_SECONDS * 1000
	// 2020-01-01 .. 2030-01-01, as epoch ms.
	const epochMs = int(1_577_836_800_000, 1_893_456_000_000)
	const traceDurationMs = Arbitrary.flatMap(
		pick(["instant", "tiny", "at_cap", "past_cap", "any"]),
		(span) => {
			switch (span) {
				case "instant":
					return Arbitrary.Constant(0)
				case "tiny":
					return int(1, 5)
				case "at_cap":
					return int(SEARCH_CAP_MS - 2, SEARCH_CAP_MS + 2)
				case "past_cap":
					return int(SEARCH_CAP_MS, 60 * DAY_MS)
				case "any":
					return int(0, SEARCH_CAP_MS)
			}
		},
	)
	const decodeLogSearch = Schema.decodeUnknownOption(V2LogSearchParams)
	const decodeWindowQuery = Schema.decodeUnknownOption(V2TelemetryWindowQuery)

	it("inspectTrace asks for logs in a window the logs search accepts, for any trace bounds", async () => {
		const traces = Arbitrary.all({ startMs: epochMs, durationMs: traceDurationMs })
		const result = await Effect.runPromise(
			Arbitrary.checkEffect(
				traces,
				({ startMs, durationMs }) =>
					Effect.gen(function* () {
						const start = new Date(startMs).toISOString()
						const sent = stubV2((url) =>
							url.includes("/logs/search")
								? listEnvelope([])
								: {
										id: "671403778c461093dbe435b41b677d18",
										object: "trace",
										start_time: start,
										end_time: new Date(startMs + durationMs).toISOString(),
										duration_ms: durationMs,
										span_count: 0,
										service_count: 0,
										truncated: false,
										spans: [],
									},
						)
						const before = sent.length
						const v2 = yield* v2Client
						yield* Remote.inspectTrace(v2, { traceId: "671403778c461093dbe435b41b677d18" })
						const body = sent.slice(before).find((r) => r.url.includes("/logs/search"))?.body
						// The logs search reads the raw logs table, so it carries the list cap.
						return Option.exists(
							decodeLogSearch(body),
							(search) =>
								search.start_time === start &&
								timeWindowViolation(
									Date.parse(search.start_time),
									Date.parse(search.end_time),
									MAX_LIST_RANGE_SECONDS,
								) === undefined,
						)
					}),
				{ runs: 200 },
			),
		)
		expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
	})

	it("every range the CLI accepts becomes a non-empty v2 window", async () => {
		// `--start`/`--end` one second either side of each other, or the same instant.
		const flags = Arbitrary.all({
			since: pick(["0m", "1m", "30m", "6h", "7d", "2w"]),
			startMs: epochMs,
			deltaSeconds: Arbitrary.flatMap(pick(["near", "any"]), (gap) =>
				gap === "near" ? int(-1, 1) : int(-7 * 86_400, 7 * 86_400),
			),
			bounds: pick(["both", "start", "end", "none"]),
		})
		const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString()
		const result = await Effect.runPromise(
			Arbitrary.checkEffect(flags, ({ since, startMs, deltaSeconds, bounds }) =>
				resolveRangeChecked({
					since,
					start:
						bounds === "both" || bounds === "start" ? Option.some(iso(startMs)) : Option.none(),
					end:
						bounds === "both" || bounds === "end"
							? Option.some(iso(startMs + deltaSeconds * 1000))
							: Option.none(),
				}).pipe(
					Effect.map((range) => {
						return Option.exists(
							decodeWindowQuery(toV2Window(range)),
							(window) =>
								timeWindowViolation(
									Date.parse(window.start_time),
									Date.parse(window.end_time),
									Number.POSITIVE_INFINITY,
								) === undefined,
						)
					}),
					// A refused range never reaches the server, which is the point.
					Effect.catchTag("@maple/cli/TimeRangeError", () => Effect.succeed(true)),
				),
			),
		)
		expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
	})
})
