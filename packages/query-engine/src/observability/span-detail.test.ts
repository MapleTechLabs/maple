import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { spanDetail } from "./span-detail"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"
import { OrgId } from "@maple/domain"
import { WarehouseQuotaExceededError } from "@maple/domain/http/warehouse-errors"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

const detailRow = {
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	parentSpanId: "",
	spanName: "GET /orders",
	rawSpanName: "GET",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-03-20 08:00:00.123456789",
	statusCode: "Unset",
	statusMessage: "",
	spanAttributes: JSON.stringify({ "http.route": "/orders" }),
	resourceAttributes: "{}",
}

const probeRow = {
	traceId: TRACE_ID,
	timestamp: "2026-03-20 07:59:58.000000000",
	endTimestamp: "2026-03-20 08:00:03.000000000",
}

const isProbe = (sql: string) => Str.includes("FROM trace_index")(sql) && !Str.includes("FROM traces")(sql)

const NOW = Date.parse("2026-03-25T00:00:00Z")
const probeBound = (sql: string, op: ">=" | "<") => new RegExp(`Timestamp ${op} '([^']+)'`).exec(sql)?.[1]
/** The fixture trace's rows fall inside this probe tier. */
const probeHits = (sql: string) => {
	const lower = probeBound(sql, ">=")
	const upper = probeBound(sql, "<")
	return (
		(lower === undefined || probeRow.endTimestamp >= lower) &&
		(upper === undefined || probeRow.timestamp < upper)
	)
}

/**
 * A warehouse holding the span. A hinted (bounded) lookup misses unless `boundedHit`, as if the
 * hint pointed elsewhere; the trace-bounds probe answers when `indexed`.
 */
type ExecutorOpts = {
	readonly indexed?: boolean
	readonly boundedHit?: boolean
	/** The probe at this index, and every later one, runs past its time limit. */
	readonly overBudgetFromProbe?: number
}

const makeExecutor = (sqls: string[], opts: ExecutorOpts = {}): WarehouseExecutorApi => ({
	orgId: OrgId.make("org_test"),
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => {
		const query = compiledQueryOf(compiled)
		sqls.push(query.sql)
		if (
			isProbe(query.sql) &&
			opts.overBudgetFromProbe !== undefined &&
			Arr.filter(sqls, isProbe).length > opts.overBudgetFromProbe
		)
			return Effect.fail(
				new WarehouseQuotaExceededError({
					message: "traceLocateProbe ran past its time limit",
					pipeName: "traceLocateProbe",
					setting: "max_execution_time",
				}),
			)
		if (isProbe(query.sql))
			return query
				.decodeFirstRow(opts.indexed === false || !probeHits(query.sql) ? [] : [probeRow])
				.pipe(Effect.orDie)
		const bounded = Str.includes("Timestamp >=")(query.sql)
		return query
			.decodeFirstRow(!bounded || opts.boundedHit === true ? [detailRow] : [])
			.pipe(Effect.orDie)
	},
	query: () => Effect.succeed({ data: [] }),
})

const run = (
	sqls: string[],
	timestampHint?: Date,
	opts?: ExecutorOpts,
	lookup?: { readonly nowMs?: number; readonly lookbackHours?: number },
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(lookup?.nowMs ?? NOW)
		return yield* spanDetail({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			timestampHint,
			...(lookup?.lookbackHours === undefined ? undefined : { lookbackHours: lookup.lookbackHours }),
		}).pipe(Effect.provide(Layer.succeed(WarehouseExecutor, makeExecutor(sqls, opts))))
	})

/** A timestamp hint far from where the fixture trace actually is. */
const STALE_HINT = new Date("2026-04-05T12:00:00Z")

describe("spanDetail", () => {
	it.effect("retries unbounded once when the hinted window misses", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, STALE_HINT)
			assert.isTrue(result.found)
			assert.isTrue(result.widened)
			assert.lengthOf(sqls, 2)
			assert.isFalse(Arr.some(sqls, isProbe))
			assert.deepStrictEqual(result.spanAttributes, { "http.route": "/orders" })
		}),
	)

	it.effect("without a hint, locates the trace by day tier and reads inside its bounds", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, undefined, { boundedHit: true })
			assert.isTrue(result.found)
			assert.isFalse(result.widened)
			// The last day misses; the week tier holds the trace five days back, and the day below
			// that tier's edge is checked for earlier spans.
			assert.lengthOf(sqls, 4)
			assert.isTrue(isProbe(Arr.getUnsafe(sqls, 0)))
			assert.isTrue(isProbe(Arr.getUnsafe(sqls, 1)))
			assert.include(sqls[1], "Bucket >= toStartOfFiveMinutes(toDateTime64('2026-03-18 00:00:00', 9))")
			assert.include(sqls[3], "Timestamp >= '2026-03-20 07:59:57'")
		}),
	)

	it.effect("reports an unindexed trace as not found after the tiers, none wider than a year", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, undefined, { indexed: false })
			assert.isFalse(result.found)
			// 24h, 7d, 30d, 90d, 365d, then the rest of the 730 days.
			assert.lengthOf(sqls, 6)
			assert.isTrue(Arr.every(sqls, (sql) => isProbe(sql) && Str.includes("Bucket >=")(sql)))
			assert.include(sqls[4], "Bucket >= toStartOfFiveMinutes(toDateTime64('2025-03-25 00:00:00', 9))")
			assert.include(sqls[5], "Bucket >= toStartOfFiveMinutes(toDateTime64('2024-03-25 00:00:00', 9))")
		}),
	)

	it.effect("reports not found when a probe runs past its budget, without probing older tiers", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			// The trace sits in the week tier; the probe of that tier times out.
			const result = yield* run(sqls, undefined, { boundedHit: true, overBudgetFromProbe: 1 })
			assert.isFalse(result.found)
			assert.lengthOf(sqls, 2)
		}),
	)

	it.effect("keeps the bounds found so far when the walk back runs past its budget", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			// The week tier finds the trace; the day below its edge times out.
			const result = yield* run(sqls, undefined, { boundedHit: true, overBudgetFromProbe: 2 })
			assert.isTrue(result.found)
			assert.include(sqls[3], "Timestamp >= '2026-03-20 07:59:57'")
		}),
	)

	it.effect("reaches a trace past 30 days unless the org's horizon is shorter", () =>
		Effect.gen(function* () {
			// The fixture trace is 66 days old by then.
			const nowMs = Date.parse("2026-05-25T00:00:00Z")
			const within30Days = yield* run(
				[],
				undefined,
				{ boundedHit: true },
				{ nowMs, lookbackHours: 30 * 24 },
			)
			assert.isFalse(within30Days.found)
			const sqls: string[] = []
			const kept = yield* run(sqls, undefined, { boundedHit: true }, { nowMs, lookbackHours: 90 * 24 })
			assert.isTrue(kept.found)
			// The 90-day tier holds it, after the day, week and month tiers miss.
			assert.include(sqls[3], "Bucket >= toStartOfFiveMinutes(toDateTime64('2026-02-24 00:00:00', 9))")
			// Without a horizon the lookup may reach 730 days, but stops at the same tier.
			const defaultSqls: string[] = []
			const byDefault = yield* run(defaultSqls, undefined, { boundedHit: true }, { nowMs })
			assert.isTrue(byDefault.found)
			assert.include(
				defaultSqls[3],
				"Bucket >= toStartOfFiveMinutes(toDateTime64('2026-02-24 00:00:00', 9))",
			)
			assert.isFalse(Arr.some(defaultSqls, Str.includes("2024-05-25")))
		}),
	)

	it.effect("probes no further back than a shorter lookback", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			// Five days old, and the lookback is three.
			const result = yield* run(sqls, undefined, { boundedHit: true }, { lookbackHours: 3 * 24 })
			assert.isFalse(result.found)
			assert.lengthOf(sqls, 2)
			assert.include(sqls[1], "Bucket >= toStartOfFiveMinutes(toDateTime64('2026-03-22 00:00:00', 9))")
		}),
	)

	it.effect("does not widen a miss inside the trace's own bounds", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, undefined, { boundedHit: false })
			assert.isFalse(result.found)
			assert.isFalse(result.widened)
			assert.lengthOf(sqls, 4)
		}),
	)

	it.effect("returns the stored name, status and timing beside the attributes", () =>
		Effect.gen(function* () {
			const result = yield* run([], undefined, { boundedHit: true })
			assert.deepStrictEqual(result.span, {
				spanName: "GET /orders",
				rawSpanName: "GET",
				serviceName: "api",
				spanKind: "Server",
				durationMs: 12,
				startTime: "2026-03-20 08:00:00.123",
				statusCode: "Unset",
				statusMessage: "",
			})
		}),
	)
})
