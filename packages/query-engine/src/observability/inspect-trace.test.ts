import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { inspectTrace } from "./inspect-trace"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"

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

/**
 * `span_hierarchy` answers only inside `window` (the trace's real location);
 * the probe answers with `probeTimestamp` when set.
 */
const makeExecutor = (
	captured: Captured,
	opts: { window?: { start: string; end: string }; probeTimestamp?: string },
): WarehouseExecutorApi => ({
	orgId: "org_test",
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => {
		const query = compiledQueryOf(compiled)
		captured.probes.push(query.sql)
		return query
			.decodeFirstRow(opts.probeTimestamp ? [{ timestamp: opts.probeTimestamp }] : [])
			.pipe(Effect.orDie)
	},
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		const inWindow =
			opts.window !== undefined &&
			String(params.start_time) <= opts.window.start &&
			String(params.end_time) >= opts.window.end
		const data: ReadonlyArray<Record<string, unknown>> = pipe === "span_hierarchy" && inWindow ? [spanRow] : []
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
				makeExecutor(captured, { window: { start: "2026-04-09 12:00:00", end: "2026-04-09 12:00:00" } }),
			)
			assert.strictEqual(result.spanCount, 1)
			assert.lengthOf(captured.probes, 0)
			assert.strictEqual(hierarchyCalls(captured)[0]?.params.start_time, "2026-04-09 00:00:00")
		}),
	)

	it.effect("finds a trace older than the default lookback by probing further back once", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(
				makeExecutor(captured, {
					window: { start: "2026-03-20 08:00:00", end: "2026-03-20 08:00:00" },
					probeTimestamp: "2026-03-20 08:00:00.250000000",
				}),
			)
			assert.strictEqual(result.spanCount, 1)
			assert.lengthOf(captured.probes, 1)
			// 30 days before NOW bounds the probe's partition seek.
			assert.include(captured.probes[0], "Timestamp >= '2026-03-11 00:00:00'")
			const second = hierarchyCalls(captured)[1]
			assert.strictEqual(second?.params.start_time, "2026-03-20 07:00:00")
			assert.strictEqual(second?.params.end_time, "2026-03-20 09:00:00")
		}),
	)

	it.effect("returns empty after one probe when the trace is nowhere", () =>
		Effect.gen(function* () {
			const captured: Captured = { pipeCalls: [], probes: [] }
			const result = yield* run(makeExecutor(captured, {}))
			assert.strictEqual(result.spanCount, 0)
			assert.lengthOf(captured.probes, 1)
			assert.lengthOf(hierarchyCalls(captured), 1)
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
})
