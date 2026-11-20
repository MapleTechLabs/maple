import { afterEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import {
	PromqlBadQueryError,
	PromqlQueryService,
	type PromqlQuery,
} from "@maple/backend/services/promql/PromqlQueryService"
import { CurrentMcpTenant } from "../tenant"
import { renderToolDoc } from "../lib/tool-doc"
import { capSeries, defaultStepSeconds, parseStepMs, type PromqlResult } from "../lib/promql-result"
import { registerQueryPromqlTool } from "./query-promql"
import type { McpToolError, McpToolRegistrar } from "./types"
import type { McpToolRequirements } from "./runtime-services"
import type { ToolDoc } from "../lib/tool-doc"
import { unimplementedMcpToolServices } from "../../../test/mcp/unimplemented-tool-services"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const WINDOW = { start_time: "2026-11-15 10:00:00", end_time: "2026-11-15 11:00:00" }
const END_MS = Date.parse("2026-11-15T11:00:00Z")

type Invoke = (
	params: Readonly<Record<string, unknown>>,
) => Effect.Effect<
	{ readonly output: unknown; readonly doc: ToolDoc; readonly text: string },
	McpToolError,
	McpToolRequirements
>

const promqlTool = (): Invoke => {
	let invoke: Invoke = () => Effect.die("unregistered")
	const registrar: McpToolRegistrar = {
		define: (spec) => {
			invoke = (params) =>
				Schema.decodeEffect(spec.parameters)(params).pipe(
					Effect.orDie,
					Effect.flatMap(spec.handler),
					Effect.map((output) => {
						const doc = spec.render(output)
						return { output, doc, text: renderToolDoc(doc) }
					}),
				)
		},
	}
	registerQueryPromqlTool(registrar)
	return invoke
}

/** A service answer whose `warnings` may be left out (none). */
type Stubbed<T> = T extends unknown
	? Omit<T, "warnings"> & { readonly warnings?: ReadonlyArray<string> }
	: never

/** Runs the tool against a PromQL service that records each query and answers with `answer`. */
const run = (
	params: Readonly<Record<string, unknown>>,
	answer: (input: PromqlQuery) => Effect.Effect<Stubbed<PromqlResult>, PromqlBadQueryError>,
	calls: Array<PromqlQuery> = [],
) =>
	// it.effect starts its clock at 0; the window must be in the past.
	TestClock.setTime(END_MS + 60_000).pipe(
		Effect.andThen(promqlTool()(params)),
		Effect.provide(
			Layer.mergeAll(
				Layer.mock(PromqlQueryService)({
					query: (_tenant, input) => {
						calls.push(input)
						return Effect.map(answer(input), (result) => ({ warnings: [], ...result }))
					},
				}),
				Layer.succeed(CurrentMcpTenant, {
					orgId: Schema.decodeSync(OrgId)("org_promql"),
					userId: Schema.decodeSync(UserId)("user_promql"),
					roles: [],
					authMode: "self_hosted",
				}),
			).pipe(
				Layer.provideMerge(unimplementedMcpToolServices),
				Layer.provide(Layer.mergeAll(createTestDb(trackedDbs).layer, EdgeCacheServiceLive)),
				Layer.provideMerge(Env.layer),
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							TINYBIRD_HOST: "https://api.tinybird.co",
							TINYBIRD_TOKEN: "test-token",
							MAPLE_AUTH_MODE: "self_hosted",
							MAPLE_ROOT_PASSWORD: "test-root-password",
							MAPLE_DEFAULT_ORG_ID: "default",
							MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
							MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
							INTERNAL_SERVICE_TOKEN: "test-internal-token",
						}),
					),
				),
			),
		),
	)

const series = (job: string, values: ReadonlyArray<number>, stepMs = 30_000) => ({
	labels: { job, http_route: "/checkout" },
	points: Arr.map(values, (v, i) => ({ t: END_MS - (values.length - 1 - i) * stepMs, v })),
})

const QUERY = "sum by (job, http_route) (rate(http_server_request_duration_seconds_count[5m]))"

describe("query_promql", () => {
	it.effect("evaluates a range at a default step and renders each series' stats and points", () =>
		Effect.gen(function* () {
			const calls: Array<PromqlQuery> = []
			const { text } = yield* run(
				{ query: QUERY, ...WINDOW },
				() =>
					Effect.succeed({
						resultType: "matrix" as const,
						result: [series("api", [2, 4, 6]), series("web", [1, Number.NaN, 0.5])],
					}),
				calls,
			)
			// One hour at 30s is 120 points.
			expect(calls).toEqual([
				{ query: QUERY, startMs: END_MS - 3_600_000, endMs: END_MS, stepMs: 30_000 },
			])
			expect(text).toContain("Step: 30s")
			expect(text).toContain('| {http_route="/checkout", job="api"} | 3 | 2 | 4 | 6 | 6 |')
			expect(text).toContain('| {http_route="/checkout", job="web"} | 3 | 0.5 | 0.75 | 1 | 0.5 |')
			expect(text).toContain(
				'{http_route="/checkout", job="web"}: 11-15 10:59:00 1, 11-15 10:59:30 NaN, 11-15 11:00:00 0.5',
			)
		}),
	)

	it.effect("evaluates once at end_time for an instant query", () =>
		Effect.gen(function* () {
			const calls: Array<PromqlQuery> = []
			const { output, text } = yield* run(
				{ query: "up", ...WINDOW, instant: true },
				() =>
					Effect.succeed({
						resultType: "vector" as const,
						result: [{ labels: { __name__: "up", job: "api" }, value: 1, t: END_MS }],
					}),
				calls,
			)
			expect(calls).toEqual([{ query: "up", startMs: END_MS, endMs: END_MS, stepMs: 0 }])
			expect(output).toMatchObject({
				resultType: "vector",
				instant: true,
				stepSeconds: 0,
				totalSeries: 1,
			})
			expect(text).toContain("| Series | Value |")
			expect(text).toContain('| up{job="api"} | 1 |')
			expect(text).not.toContain("Step:")
		}),
	)

	it.effect("reports invalid PromQL as invalid input with the parser's message", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				run({ query: "sum(rate(x[5m]", ...WINDOW }, () =>
					Effect.fail(
						new PromqlBadQueryError({ message: "unclosed left parenthesis", position: 4 }),
					),
				),
			)
			expect(error).toMatchObject({
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "query",
				message: "Invalid PromQL: unclosed left parenthesis (at position 4)",
			})
		}),
	)

	it.effect("refuses a step that is not a duration", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				run({ query: "up", ...WINDOW, step: "soon" }, () => Effect.die("not reached")),
			)
			expect(error).toMatchObject({ _tag: "@maple/mcp/errors/McpInvalidInputError", parameter: "step" })
		}),
	)

	it.effect("runs whole-millisecond steps exactly, whatever their float spelling", () =>
		Effect.gen(function* () {
			const calls: Array<PromqlQuery> = []
			yield* Effect.forEach(["9ms", "1.001", "0.009", "1m30s"], (step) =>
				run(
					{ query: "up", start_time: "2026-11-15 10:59:00", end_time: "2026-11-15 11:00:00", step },
					() => Effect.succeed({ resultType: "matrix" as const, result: [] }),
					calls,
				),
			)
			expect(Arr.map(calls, (c) => c.stepMs)).toEqual([9, 1001, 9, 90_000])
		}),
	)

	it.effect("refuses a sub-millisecond or overflowing step before querying", () =>
		Effect.gen(function* () {
			const errors = yield* Effect.forEach(
				["0.0004", "1000.0004", "1000.0005", "1e308", "999999999999999999y"],
				(step) => Effect.flip(run({ query: "up", ...WINDOW, step }, () => Effect.die("not reached"))),
			)
			expect(errors).toMatchObject(
				Arr.map(errors, () => ({
					_tag: "@maple/mcp/errors/McpInvalidInputError",
					parameter: "step",
				})),
			)
		}),
	)

	it.effect("refuses a step too fine for the window as a step error, before querying", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				run({ query: "up", ...WINDOW, step: "100ms" }, () => Effect.die("not reached")),
			)
			expect(error).toMatchObject({ _tag: "@maple/mcp/errors/McpInvalidInputError", parameter: "step" })
		}),
	)

	it.effect("allows exactly the engine's step limit and refuses one step more", () =>
		Effect.gen(function* () {
			// 1 100 s at 100ms is exactly 11 000 steps, which Prometheus and the engine accept.
			const window = { start_time: "2026-11-15 10:00:00", end_time: "2026-11-15 10:18:20" }
			const calls: Array<PromqlQuery> = []
			yield* run(
				{ query: "up", ...window, step: "100ms" },
				() => Effect.succeed({ resultType: "matrix" as const, result: [] }),
				calls,
			)
			expect(calls).toHaveLength(1)
			const error = yield* Effect.flip(
				run({ query: "up", ...window, step: "99ms" }, () => Effect.die("not reached")),
			)
			expect(error).toMatchObject({ _tag: "@maple/mcp/errors/McpInvalidInputError", parameter: "step" })
		}),
	)

	it.effect("prints a sub-second step the way the step parameter accepts it", () =>
		Effect.gen(function* () {
			const { text } = yield* run({ query: "up", ...WINDOW, step: "500ms" }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: [series("api", [1])] }),
			)
			expect(text).toContain("500ms")
			expect(text).not.toContain("0.5s")
		}),
	)

	it.effect("keeps the 20 highest series and the last 200 points, and suggests summing by service", () =>
		Effect.gen(function* () {
			const many = Arr.makeBy(25, (i) =>
				series(
					`svc-${i}`,
					Arr.makeBy(300, (k) => i + k / 1000),
				),
			)
			const { output, doc, text } = yield* run({ query: QUERY, ...WINDOW, step: "1m" }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: many }),
			)
			const decoded = Schema.decodeUnknownSync(
				Schema.Struct({
					totalSeries: Schema.Number,
					series: Schema.Array(
						Schema.Struct({
							labels: Schema.Record(Schema.String, Schema.String),
							points: Schema.Array(Schema.Unknown),
							totalPoints: Schema.Number,
						}),
					),
				}),
			)(output)
			expect(decoded.totalSeries).toBe(25)
			expect(decoded.series).toHaveLength(20)
			expect(decoded.series[0]?.labels.job).toBe("svc-24")
			expect(Arr.map(decoded.series, (s) => s.points.length)).toEqual(Arr.makeBy(20, () => 200))
			expect(decoded.series[0]?.totalPoints).toBe(300)
			expect(text).toContain("Showing 20 of 25 series (highest peaks kept).")
			expect(text).toContain("Note: Each series shows its last 200 points")
			expect(doc.next).toEqual([
				{
					tool: "query_promql",
					args: { query: `sum by (job) (${QUERY})`, ...WINDOW, step: "60s" },
					why: "fewer series: one per service",
				},
			])
		}),
	)

	it.effect("suggests a sub-second step the tool accepts again", () =>
		Effect.gen(function* () {
			const many = Arr.makeBy(25, (i) => series(`svc-${i}`, [i]))
			const { doc } = yield* run({ query: QUERY, ...WINDOW, step: "500ms" }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: many }),
			)
			expect(doc.next?.[0]?.args).toMatchObject({ step: "500ms" })
		}),
	)
})

describe("query_promql steps", () => {
	it("reads Prometheus durations and seconds", () => {
		expect(parseStepMs("1m")).toBe(60_000)
		expect(parseStepMs("1h30m")).toBe(5_400_000)
		expect(parseStepMs("15")).toBe(15_000)
		expect(parseStepMs("0")).toBeUndefined()
		expect(parseStepMs("0s")).toBeUndefined()
		expect(parseStepMs("1 minute")).toBeUndefined()
	})

	it("picks a round step giving at most 120 points", () => {
		expect(defaultStepSeconds(3600)).toBe(30)
		expect(defaultStepSeconds(120)).toBe(1)
		expect(defaultStepSeconds(600)).toBe(5)
		expect(defaultStepSeconds(6 * 3600)).toBe(300)
		expect(defaultStepSeconds(7 * 86_400)).toBe(7200)
	})

	it("keeps an infinite series when capping, the way a peak ranks", () => {
		const series = (i: number, v: number) => ({ labels: { id: String(i) }, points: [{ t: 0, v }] })
		const result: PromqlResult = {
			warnings: [],
			resultType: "matrix",
			result: [
				series(0, Number.POSITIVE_INFINITY),
				...Array.from({ length: 25 }, (_, i) => series(i + 1, i)),
			],
		}
		expect(capSeries(result).some((s) => s.labels.id === "0")).toBe(true)
	})
})

describe("query_promql rendering", () => {
	it.effect("escapes a | in a label once in the table", () =>
		Effect.gen(function* () {
			const { text } = yield* run({ query: QUERY, ...WINDOW, step: "1m" }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: [series("a|b", [1])] }),
			)
			expect(text).toContain("a\\|b")
			expect(text).not.toContain("a\\\\\\|b")
		}),
	)

	it.effect("quotes label values, so a value holding a quote is not another label", () =>
		Effect.gen(function* () {
			const { text } = yield* run({ query: QUERY, ...WINDOW, step: "1m" }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: [series('a", y="b', [1])] }),
			)
			// The table cell escapes the backslash again; the ambiguous unquoted form never appears.
			expect(text).toContain('job="a\\\\", y=\\\\"b"')
			expect(text).not.toContain('job="a", y="b"')
		}),
	)
})

describe("query_promql empty results", () => {
	it.effect("tells an instant query to move end_time, not widen start_time", () =>
		Effect.gen(function* () {
			const { text } = yield* run({ query: QUERY, ...WINDOW, instant: true }, () =>
				Effect.succeed({ resultType: "vector" as const, result: [] }),
			)
			expect(text).toContain("move end_time")
			expect(text).not.toContain("Widen start_time")
		}),
	)

	it.effect("leads with the engine's nearest-name warnings when nothing matched", () =>
		Effect.gen(function* () {
			const hint =
				'no metric named "http_request_total" in the query window; did you mean "http_requests_total"?'
			const { output, text } = yield* run({ query: "http_request_total", ...WINDOW }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: [], warnings: [hint] }),
			)
			expect(output).toMatchObject({ warnings: [hint] })
			expect(text).toContain(hint)
			// The engine named the metric; the generic naming advice would only repeat it.
			expect(text).not.toContain("Labels use underscores")
		}),
	)

	it.effect("shows warnings as notes beside series", () =>
		Effect.gen(function* () {
			const hint = 'no metric named "x_total" in the query window'
			const { text } = yield* run({ query: `${QUERY} or x_total`, ...WINDOW }, () =>
				Effect.succeed({
					resultType: "matrix" as const,
					result: [series("api", [1])],
					warnings: [hint],
				}),
			)
			expect(text).toContain(`Note: ${hint}`)
		}),
	)
})

describe("query_promql statistics", () => {
	it.effect("summarises every point, not only the listed ones", () =>
		Effect.gen(function* () {
			// The peak sits before the last 200 points, which are all that get listed.
			const values = Arr.map(Arr.range(1, 241), (i) => (i === 10 ? 99 : 1))
			const { text } = yield* run({ query: QUERY, ...WINDOW, step: "15s" }, () =>
				Effect.succeed({ resultType: "matrix" as const, result: [series("svc", values, 15_000)] }),
			)
			expect(text).toContain("| 241 | 1 | 1.407 | 99 | 1 |")
		}),
	)

	it.effect("counts infinite points in the statistics and shows seconds in sampled times", () =>
		Effect.gen(function* () {
			const { text } = yield* run({ query: QUERY, ...WINDOW, step: "15s" }, () =>
				Effect.succeed({
					resultType: "matrix" as const,
					result: [series("svc", [1, Number.POSITIVE_INFINITY])],
				}),
			)
			expect(text).toContain("| +Inf |")
			expect(text).toContain("11-15 10:59:30 1, 11-15 11:00:00 +Inf")
		}),
	)
})
