// `maple promql`: parsing and windows, the output both backends share, its table, and the real
// binary against a stub workspace (the hosted MCP tool and the Prometheus API).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Exit, Option, Schema, String as Str } from "effect"
import type { QueryResult } from "@maple/promql"
import {
	caretLines,
	evaluationWindow,
	parseQuery,
	parseStepMs,
	toPromqlOutput,
	type PromqlOutput,
} from "../src/core/promql"
import { renderSections } from "../src/lib/output"
import { commonLabels, formatLabels, promqlNotes, promqlView, sparkline } from "../src/lib/promql-view"

const RANGE = { startTime: "2026-11-20 00:00:00", endTime: "2026-11-20 01:00:00" }
const END_MS = Date.UTC(2026, 10, 20, 1)
const START_MS = END_MS - 3_600_000

const lines = Str.split("\n")

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect)
const failureMessage = <A>(exit: Exit.Exit<A, { readonly message: string; readonly hint?: string }>) =>
	Exit.isFailure(exit)
		? Arr.map(exit.cause.reasons, (r) => (r._tag === "Fail" ? r.error : undefined))[0]
		: undefined

describe("parseQuery", () => {
	test("points at the syntax error with a caret", () => {
		const error = failureMessage(run(parseQuery('rate(http_requests_total{job="api"[5m])', false)))
		expect(lines(error?.message ?? "")).toEqual([
			'invalid PromQL at position 34: syntax error near "["',
			'  rate(http_requests_total{job="api"[5m])',
			`  ${Str.repeat(34)(" ")}^`,
		])
		expect(error?.hint).toContain("maple promql metrics")
	})

	test("puts the caret on the line that holds the position", () => {
		expect(caretLines("sum(\n  rate(x[5m]", 12)).toEqual(["    rate(x[5m]", "         ^"])
	})

	test("refuses a range vector over a range, and takes it with --instant", () => {
		const error = failureMessage(run(parseQuery("http_requests_total[5m]", false)))
		expect(error?.message).toBe("a range vector cannot be evaluated over a range")
		expect(Exit.isSuccess(run(parseQuery("http_requests_total[5m]", true)))).toBe(true)
	})
})

describe("evaluationWindow", () => {
	test("picks a round step for about 60 to 120 points", () => {
		const exit = run(evaluationWindow({ range: RANGE, instant: false }))
		expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
			startMs: START_MS,
			endMs: END_MS,
			stepMs: 30_000,
			stepSeconds: 30,
		})
	})

	test("takes a Prometheus duration or seconds", () => {
		const duration = run(evaluationWindow({ range: RANGE, instant: false, step: "1m30s" }))
		const seconds = run(evaluationWindow({ range: RANGE, instant: false, step: "15" }))
		expect(Exit.isSuccess(duration) && duration.value.stepMs).toBe(90_000)
		expect(Exit.isSuccess(seconds) && seconds.value.stepMs).toBe(15_000)
	})

	test("refuses a range longer than seven days, which an instant query may still look back over", () => {
		const range = { startTime: "2026-11-06 00:00:00", endTime: "2026-11-20 00:00:00" }
		const error = failureMessage(run(evaluationWindow({ range, instant: false })))
		expect(error?.message).toBe("a PromQL range covers at most 7d")
		expect(Exit.isSuccess(run(evaluationWindow({ range, instant: true })))).toBe(true)
		const week = { startTime: "2026-11-13 00:00:00", endTime: "2026-11-20 00:00:00" }
		expect(Exit.isSuccess(run(evaluationWindow({ range: week, instant: false })))).toBe(true)
	})

	test("reads numeric steps as decimal seconds, as the hosted tool does", () => {
		expect(parseStepMs("060")).toBe(60_000)
		expect(parseStepMs("1.5")).toBe(1_500)
		expect(parseStepMs("0.0005")).toBeUndefined()
		expect(parseStepMs("1h30m")).toBe(5_400_000)
		expect(parseStepMs("0s")).toBeUndefined()
	})

	test("evaluates once at the end with --instant", () => {
		const exit = run(evaluationWindow({ range: RANGE, instant: true, step: "nonsense" }))
		expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
			startMs: END_MS,
			endMs: END_MS,
			stepMs: 0,
		})
	})

	test("refuses a step that is not a duration, or too fine for the window", () => {
		expect(
			failureMessage(run(evaluationWindow({ range: RANGE, instant: false, step: "1x" })))?.message,
		).toBe('--step "1x" is not a Prometheus duration or a number of seconds')
		const fine = failureMessage(run(evaluationWindow({ range: RANGE, instant: false, step: "100ms" })))
		expect(fine?.message).toContain("steps over this window")
		expect(fine?.hint).toBe("use at least --step 1s, or a shorter window")
	})
})

const WINDOW = { range: RANGE, startMs: START_MS, endMs: END_MS, stepMs: 60_000, stepSeconds: 60 }
const INSTANT = { range: RANGE, startMs: END_MS, endMs: END_MS, stepMs: 0, stepSeconds: 0 }

const matrix = (count: number, points: number): QueryResult => ({
	resultType: "matrix",
	result: Array.from({ length: count }, (_, i) => ({
		labels: { __name__: "up", job: `svc-${i}`, env: "prod" },
		points: Array.from({ length: points }, (_, p) => ({ t: START_MS + p * 60_000, v: i + p / 10 })),
	})),
})

describe("toPromqlOutput", () => {
	test("keeps the 20 highest-peaking series and the last 200 points of each", () => {
		const output = toPromqlOutput("up", WINDOW, matrix(25, 250))
		expect(output.totalSeries).toBe(25)
		expect(Arr.map(output.series, (s) => s.labels.job)).toEqual(
			Array.from({ length: 20 }, (_, i) => `svc-${24 - i}`),
		)
		expect(output.series[0]?.points).toHaveLength(200)
		expect(output.series[0]?.totalPoints).toBe(250)
		expect(output.series[0]?.stats).toEqual({ min: 24, avg: 24 + 24.9 / 2, max: 48.9 })
		expect(promqlNotes(output)).toEqual([
			"showing 20 of 25 series (highest peaks); aggregate with sum by (...) to see all",
			"trend shows the last 200 points of each series",
		])
	})

	test("spells non-finite samples as Prometheus does and leaves stats out when all are NaN", () => {
		const output = toPromqlOutput("x", INSTANT, {
			resultType: "vector",
			result: [
				{ labels: { a: "1" }, t: END_MS, value: Number.POSITIVE_INFINITY },
				{ labels: { a: "2" }, t: END_MS, value: Number.NaN },
			],
		})
		expect(output.instant).toBe(true)
		expect(Arr.map(output.series, (s) => s.points[0]?.v)).toEqual(["+Inf", "NaN"])
		expect(output.series[1]?.stats).toBeUndefined()
	})

	test("reads a scalar as one unlabelled series and a string as its value", () => {
		const scalar = toPromqlOutput("1+1", INSTANT, { resultType: "scalar", result: { t: END_MS, v: 2 } })
		expect(scalar.series).toEqual([
			{ labels: {}, points: [{ t: END_MS, v: 2 }], totalPoints: 1, stats: { min: 2, avg: 2, max: 2 } },
		])
		const text = toPromqlOutput('"hi"', INSTANT, { resultType: "string", result: { t: END_MS, v: "hi" } })
		expect(text.series).toEqual([])
		expect(text.stringValue).toBe("hi")
	})
})

const table = (output: PromqlOutput) => renderSections(promqlView("empty").table?.(output) ?? [])

describe("table", () => {
	test("a matrix lists each series with its stats and a sparkline, shared labels hoisted", () => {
		const rendered = table(toPromqlOutput("up", WINDOW, matrix(2, 3)))
		expect(lines(rendered)).toEqual([
			"query   up",
			"result  matrix",
			"window  2026-11-20 00:00:00 .. 2026-11-20 01:00:00 UTC",
			"step    60s",
			'labels  up{env="prod"} (on every series)',
			"",
			"SERIES         LAST  MIN  AVG  MAX  POINTS  TREND",
			'{job="svc-0"}   0.2    0  0.1  0.2       3  ▁▅█',
			'{job="svc-1"}   1.2    1  1.1  1.2       3  ▁▅█',
		])
	})

	test("a vector shows one value per series at the evaluation time", () => {
		const rendered = table(
			toPromqlOutput("up", INSTANT, {
				resultType: "vector",
				result: [{ labels: { __name__: "up" }, t: END_MS, value: 1 }],
			}),
		)
		expect(lines(rendered)).toEqual([
			"query   up",
			"result  vector",
			"at      2026-11-20 01:00:00 UTC",
			"",
			"SERIES  VALUE",
			"up          1",
		])
	})

	test("a scalar reads as one value", () => {
		const rendered = table(
			toPromqlOutput("1+1", INSTANT, { resultType: "scalar", result: { t: END_MS, v: 2 } }),
		)
		expect(Arr.takeRight(lines(rendered), 2)).toEqual(["SERIES  VALUE", "scalar      2"])
	})

	test("labels print in Prometheus' spelling; one series hoists nothing", () => {
		expect(formatLabels({ b: "2", __name__: "m", a: "1" })).toBe('m{a="1", b="2"}')
		expect(formatLabels({})).toBe("{}")
		expect(formatLabels({ a: 'x", b="y' })).toBe('{a="x\\", b=\\"y"}')
		expect(formatLabels({ path: "C:\\tmp\nnext" })).toBe('{path="C:\\\\tmp\\nnext"}')
		expect(commonLabels(toPromqlOutput("up", WINDOW, matrix(1, 2)).series)).toEqual({})
		const own = toPromqlOutput("x", INSTANT, {
			resultType: "vector",
			result: [{ labels: { constructor: "c" }, t: END_MS, value: 1 }],
		})
		expect(table(own)).toContain('{constructor="c"}')
	})

	test("sparkline averages into the width and leaves gaps for NaN", () => {
		expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█")
		expect(sparkline([0, 0, 10, 10], 2)).toBe("▁█")
		expect(sparkline([1, "NaN", 3])).toBe("▁ █")
		expect(sparkline([5, 5])).toBe("▄▄")
	})
})

// The real binary against a stub workspace, in remote mode.
const CLI = join(import.meta.dir, "..", "src", "bin.ts")

const TOOL_OUTPUT: PromqlOutput = {
	query: "sum by (job) (rate(http_server_request_duration_seconds_count[5m]))",
	resultType: "matrix",
	instant: false,
	timeRange: { start: "2026-11-20 00:00:00", end: "2026-11-20 01:00:00" },
	stepSeconds: 60,
	series: [
		{
			labels: { job: "checkout", timestamp: "2026-11-20 00:00:00" },
			points: [
				{ t: START_MS, v: 1 },
				{ t: START_MS + 60_000, v: 3 },
			],
			totalPoints: 2,
			stats: { min: 1, avg: 2, max: 3 },
		},
	],
	totalSeries: 1,
}

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

const decodeToolCall = Schema.decodeUnknownSync(
	Schema.Struct({
		id: Schema.Number,
		params: Schema.Struct({ arguments: Schema.Struct({ query: Schema.String }) }),
	}),
)

const calls: Array<{ readonly path: string; readonly body: object }> = []

/** The body of the last request to a path ending in `suffix`. */
const lastCall = (suffix: string): object | undefined =>
	Option.getOrUndefined(
		Option.map(
			Arr.findLast(calls, (c) => Str.endsWith(suffix)(c.path)),
			(c) => c.body,
		),
	)

let server: ReturnType<typeof Bun.serve>
let home: string

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "maple-promql-cli-"))
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === "/v2/metrics/prometheus/api/v1/label/__name__/values") {
				calls.push({
					path: url.pathname,
					body: { start: url.searchParams.get("start"), end: url.searchParams.get("end") },
				})
				return Response.json({
					status: "success",
					data: ["http_requests_total", "process_cpu_seconds_total", "up"],
				})
			}
			const raw = decodeRecord(await request.json())
			const body = decodeToolCall(raw)
			calls.push({ path: url.pathname, body: raw })
			const query = body.params.arguments.query
			const result =
				query === "bad"
					? {
							isError: true,
							content: [{ type: "text", text: "Invalid input: query exceeds the step limit" }],
						}
					: { content: [{ type: "text", text: "ok" }], structuredContent: TOOL_OUTPUT }
			return Response.json({ jsonrpc: "2.0", id: body.id, result })
		},
	})
})

afterAll(() => {
	void server.stop(true)
	rmSync(home, { recursive: true, force: true })
})

const cli = async (args: ReadonlyArray<string>) => {
	const proc = Bun.spawn(["bun", CLI, ...args, "--remote"], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			MAPLE_API_URL: server.url.origin,
			MAPLE_API_TOKEN: "maple_ak_test",
			MAPLE_TELEMETRY: "0",
			MAPLE_NO_UPDATE_CHECK: "1",
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { stdout, stderr, code }
}

describe("maple promql against a workspace", () => {
	test("sends the query, step and window to query_promql and prints its series", async () => {
		const out = await cli([
			"promql",
			TOOL_OUTPUT.query,
			"--start",
			"2026-11-20 00:00:00",
			"--end",
			"2026-11-20 01:00:00",
			"--step",
			"1m",
			"--format",
			"table",
		])
		expect(out.code).toBe(0)
		expect(out.stdout).toContain(
			'{job="checkout", timestamp="2026-11-20 00:00:00"}     3    1    2    3       2  ▁█',
		)
		expect(lastCall("/mcp")).toMatchObject({
			method: "tools/call",
			params: {
				name: "query_promql",
				arguments: {
					query: TOOL_OUTPUT.query,
					start_time: "2026-11-20 00:00:00",
					end_time: "2026-11-20 01:00:00",
					step: "1m",
				},
			},
		})
	}, 30_000)

	test("prints the tool's output unchanged as JSON", async () => {
		const out = await cli(["promql", TOOL_OUTPUT.query, "--instant"])
		expect(out.code).toBe(0)
		expect(JSON.parse(out.stdout)).toEqual(TOOL_OUTPUT)
		expect(lastCall("/mcp")).toMatchObject({
			params: { arguments: { instant: true } },
		})
	}, 30_000)

	test("a syntax error fails before any request, with the caret", async () => {
		const before = calls.length
		const out = await cli(["promql", "sum(rate(x[5m])"])
		expect(out.code).toBe(1)
		expect(out.stderr).toContain(
			"error: invalid PromQL at position 15: unexpected end of input\n  sum(rate(x[5m])\n                 ^",
		)
		expect(calls.length).toBe(before)
	}, 30_000)

	test("the workspace's refusal is the error line", async () => {
		const out = await cli(["promql", "bad"])
		expect(out.code).toBe(1)
		expect(out.stderr).toContain("error: Invalid input: query exceeds the step limit")
	}, 30_000)

	test("metrics lists Prometheus names, filtered", async () => {
		const out = await cli(["promql", "metrics", "TOTAL", "--format", "table"])
		expect(out.code).toBe(0)
		expect(lines(Str.trim(out.stdout))).toEqual([
			"NAME",
			"http_requests_total",
			"process_cpu_seconds_total",
		])
		expect(lastCall("/values")).toMatchObject({
			start: expect.stringMatching(/Z$/),
		})
	}, 30_000)
})
