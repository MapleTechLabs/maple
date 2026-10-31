import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { inspectTrace, traceProbeWindows } from "./inspect-trace"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"
import { OrgId } from "@maple/domain"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const NOW = Date.parse("2026-04-10T00:00:00Z")

interface Captured {
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
	probes: string[]
}

const spanRow = {
	traceId: TRACE_ID,
	spanId: "b7ad6b7169203331",
	parentSpanId: "",
	spanName: "GET /orders",
	rawSpanName: "http.server GET",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-03-20 08:00:00.000000000",
	statusCode: "Unset",
	statusMessage: "",
	spanAttributes: JSON.stringify({
		"http.request.method": "GET",
		"http.route": "/orders",
		"http.response.status_code": "200",
		"cache.result": "hit",
	}),
	resourceAttributes: "{}",
	relationship: "related",
}

const probeBound = (sql: string, op: ">=" | "<") => new RegExp(`Timestamp ${op} '([^']+)'`).exec(sql)?.[1]

/**
 * `span_hierarchy` answers only inside `window` (the trace's real location);
 * the probe answers with `probeTimestamp` when set and inside its bounds.
 */
const makeExecutor = (
	captured: Captured,
	opts: { window?: { start: string; end: string }; probeTimestamp?: string },
): WarehouseExecutorApi => ({
	orgId: OrgId.make("org_test"),
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => {
		const query = compiledQueryOf(compiled)
		captured.probes.push(query.sql)
		const lower = probeBound(query.sql, ">=")
		const upper = probeBound(query.sql, "<")
		const hit =
			opts.probeTimestamp !== undefined &&
			(lower === undefined || opts.probeTimestamp >= lower) &&
			(upper === undefined || opts.probeTimestamp < upper)
		return query
			.decodeFirstRow(
				hit
					? [
							{
								traceId: "probe",
								timestamp: opts.probeTimestamp,
								endTimestamp: opts.probeTimestamp,
							},
						]
					: [],
			)
			.pipe(Effect.orDie)
	},
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		const inWindow =
			opts.window !== undefined &&
			String(params.start_time) <= opts.window.start &&
			String(params.end_time) >= opts.window.end
		const data: ReadonlyArray<Record<string, unknown>> =
			pipe === "span_hierarchy" && inWindow ? [spanRow] : []
		return Effect.succeed({ data: data as ReadonlyArray<never> })
	},
})

const run = (executor: WarehouseExecutorApi, options?: Parameters<typeof inspectTrace>[1]) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* inspectTrace(TRACE_ID, options).pipe(
			Effect.provide(Layer.succeed(WarehouseExecutor, executor)),
		)
	})

const hierarchyCalls = (captured: Captured) => captured.pipeCalls.filter((c) => c.pipe === "span_hierarchy")

describe("inspectTrace", () => {
	it.effect("reads the last 24h and does not probe when the trace is there", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(
				makeExecutor(captured, {
					window: { start: "2026-04-09 12:00:00", end: "2026-04-09 12:00:00" },
				}),
			)
			assert.strictEqual(result.spanCount, 1)
			assert.lengthOf(captured.probes, 0)
			assert.strictEqual(hierarchyCalls(captured)[0]?.params.start_time, "2026-04-09 00:00:00")
		}),
	)

	it.effect("finds a trace from the last week with one probe that skips the day already read", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(
				makeExecutor(captured, {
					window: { start: "2026-04-07 08:00:00", end: "2026-04-07 08:00:00" },
					probeTimestamp: "2026-04-07 08:00:00.250000000",
				}),
			)
			assert.strictEqual(result.spanCount, 1)
			assert.lengthOf(captured.probes, 1)
			assert.include(captured.probes[0], "Timestamp >= '2026-04-03 00:00:00'")
			assert.include(captured.probes[0], "Timestamp < '2026-04-09 00:00:00'")
		}),
	)

	it.effect("finds a trace older than a week in the widest tier", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(
				makeExecutor(captured, {
					window: { start: "2026-03-20 08:00:00", end: "2026-03-20 08:00:00" },
					probeTimestamp: "2026-03-20 08:00:00.250000000",
				}),
			)
			assert.strictEqual(result.spanCount, 1)
			assert.lengthOf(captured.probes, 2)
			// 30 days before NOW bounds the widest tier, which stops where the week tier began.
			assert.include(captured.probes[1], "Timestamp >= '2026-03-11 00:00:00'")
			assert.include(captured.probes[1], "Timestamp < '2026-04-03 00:00:00'")
			const second = hierarchyCalls(captured)[1]
			assert.strictEqual(second?.params.start_time, "2026-03-20 07:00:00")
			assert.strictEqual(second?.params.end_time, "2026-03-20 09:00:00")
		}),
	)

	it.effect("returns empty after every tier misses when the trace is nowhere", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(makeExecutor(captured, {}))
			assert.strictEqual(result.spanCount, 0)
			assert.lengthOf(captured.probes, 2)
			assert.lengthOf(hierarchyCalls(captured), 1)
			assert.deepStrictEqual(result.scanned, {
				startTime: "2026-03-11 00:00:00",
				endTime: "2026-04-10 00:00:00",
				widened: true,
			})
		}),
	)

	it.effect("widens when a timestamp hint misses the trace and reports what it scanned", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(
				makeExecutor(captured, {
					window: { start: "2026-03-20 08:00:00", end: "2026-03-20 08:00:00" },
					probeTimestamp: "2026-03-20 08:00:00.250000000",
				}),
				{ timestampHint: new Date("2026-04-05T12:00:00Z") },
			)
			assert.strictEqual(result.spanCount, 1)
			// A hint read nothing near now, so the tiers start open-ended at the last day.
			assert.lengthOf(captured.probes, 3)
			assert.notInclude(captured.probes[0], "Timestamp <")
			assert.strictEqual(hierarchyCalls(captured)[0]?.params.start_time, "2026-04-05 11:00:00")
			assert.deepStrictEqual(result.scanned, {
				startTime: "2026-03-20 07:00:00",
				endTime: "2026-03-20 09:00:00",
				widened: true,
			})
		}),
	)

	it.effect("keeps the stored span name beside a rewritten display name", () =>
		Effect.gen(function* () {
			const window = { start: "2026-04-09 12:00:00", end: "2026-04-09 12:00:00" }
			const result = yield* run(makeExecutor({ pipeCalls: [], probes: [] }, { window }))
			assert.strictEqual(result.spans[0]?.spanName, "GET /orders")
			assert.strictEqual(result.spans[0]?.rawSpanName, "http.server GET")
		}),
	)

	it.effect("reads an explicit time range as given and never widens it", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(makeExecutor(captured, { probeTimestamp: "2026-03-20 08:00:00" }), {
				timeRange: { startTime: "2026-03-01 00:00:00", endTime: "2026-03-02 00:00:00" },
			})
			assert.strictEqual(result.spanCount, 0)
			assert.lengthOf(captured.probes, 0)
			const call = hierarchyCalls(captured)[0]
			assert.strictEqual(call?.params.start_time, "2026-03-01 00:00:00")
			assert.strictEqual(call?.params.end_time, "2026-03-02 00:00:00")
		}),
	)

	it.effect("keeps the HTTP attributes only when asked to", () =>
		Effect.gen(function* () {
			const window = { start: "2026-04-09 12:00:00", end: "2026-04-09 12:00:00" }
			const trimmed = yield* run(makeExecutor({ pipeCalls: [], probes: [] }, { window }))
			assert.deepStrictEqual(trimmed.spans[0]?.attributes, { "cache.result": "hit" })

			const full = yield* run(makeExecutor({ pipeCalls: [], probes: [] }, { window }), {
				includeAttributes: true,
			})
			assert.deepStrictEqual(full.spans[0]?.attributes, {
				"http.request.method": "GET",
				"http.route": "/orders",
				"http.response.status_code": "200",
				"cache.result": "hit",
			})
		}),
	)

	it("splits the probe into non-overlapping tiers that end at the oldest bound", () => {
		const day = 24 * 60 * 60 * 1000
		assert.deepStrictEqual(traceProbeWindows({ nowMs: NOW, oldestMs: NOW - 30 * day }), [
			{ startMs: NOW - day, endMs: undefined },
			{ startMs: NOW - 7 * day, endMs: NOW - day },
			{ startMs: NOW - 30 * day, endMs: NOW - 7 * day },
		])
		assert.deepStrictEqual(
			traceProbeWindows({ nowMs: NOW, oldestMs: NOW - 3 * day, coveredSinceMs: NOW - day }),
			[{ startMs: NOW - 3 * day, endMs: NOW - day }],
		)
		assert.deepStrictEqual(
			traceProbeWindows({ nowMs: NOW, oldestMs: NOW - 30 * day, coveredSinceMs: NOW - 40 * day }),
			[],
		)
	})
})
