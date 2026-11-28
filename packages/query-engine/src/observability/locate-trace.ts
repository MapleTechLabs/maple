import { Array as Arr, DateTime, Effect, Option } from "effect"
import { MAX_RETENTION_DAYS } from "@maple/domain/retention"
import * as CH from "../ch"
import { formatWarehouseDateTime } from "../datetime"
import { WarehouseExecutor, type WarehouseExecutorError } from "./WarehouseExecutor"

const HOUR_MS = 60 * 60 * 1000

/**
 * How far back a trace lookup reaches when its caller does not know the org's traces read
 * horizon: the longest any source can keep traces. A miss costs one probe per tier.
 */
export const TRACE_LOOKUP_MAX_HOURS = MAX_RETENTION_DAYS * 24

/**
 * Probe tier edges, newest first: most lookups land in the last day or week, and no older tier
 * spans more than about a year, so a miss is several bounded probes rather than one ~2-year scan.
 */
const PROBE_TIER_HOURS = [24, 7 * 24, 30 * 24, 90 * 24, 365 * 24] as const

const DAY_MS = 24 * HOUR_MS

export interface ProbeWindow {
	readonly startMs: number
	/** Exclusive; `undefined` leaves the newest window open-ended. */
	readonly endMs: number | undefined
}

/**
 * Non-overlapping probe windows from now (open-ended) back to `oldestMs`, so a recent
 * trace costs a few partitions and a miss a probe per tier.
 */
export const traceProbeWindows = (opts: {
	readonly nowMs: number
	readonly oldestMs: number
}): ReadonlyArray<ProbeWindow> => {
	const starts = [
		...Arr.filter(
			Arr.map(PROBE_TIER_HOURS, (hours) => opts.nowMs - hours * HOUR_MS),
			(edge) => edge > opts.oldestMs,
		),
		opts.oldestMs,
	]
	return Arr.map(starts, (startMs, index) => ({
		startMs,
		endMs: index === 0 ? undefined : starts[index - 1],
	}))
}

/** The first and last span start of a trace, from `trace_index`. */
export interface TraceBounds {
	readonly startMs: number
	readonly endMs: number
}

const probeWindow = Effect.fnUntraced(function* (traceId: string, window: ProbeWindow) {
	const executor = yield* WarehouseExecutor
	const row = yield* executor.compiledQueryFirst(
		window.endMs === undefined
			? CH.compile(CH.recentTraceTimeProbeQuery({ traceId }), {
					orgId: executor.orgId,
					startTime: formatWarehouseDateTime(window.startMs),
				})
			: CH.compile(CH.recentTraceTimeProbeQuery({ traceId, endBounded: true }), {
					orgId: executor.orgId,
					startTime: formatWarehouseDateTime(window.startMs),
					endTime: formatWarehouseDateTime(window.endMs),
				}),
		{ profile: "discovery", context: "traceLocateProbe" },
	)
	return Option.map(row, (r): TraceBounds => ({
		startMs: DateTime.toEpochMillis(r.timestamp),
		endMs: DateTime.toEpochMillis(r.endTimestamp),
	}))
})

/** A probe past its `discovery` budget: the lookup ends incomplete instead of failing. */
const OVER_BUDGET = "over-budget" as const

/** `probeWindow`, with a probe that exceeded its time or memory budget reported as `OVER_BUDGET`. */
const probeWithinBudget = (traceId: string, window: ProbeWindow) =>
	probeWindow(traceId, window).pipe(
		Effect.catchTag("@maple/http/errors/WarehouseQuotaExceededError", (error) =>
			Effect.as(
				Effect.annotateCurrentSpan({
					"maple.query.probe_over_budget": true,
					"maple.query.probe_budget_setting": error.setting,
				}),
				OVER_BUDGET,
			),
		),
	)

const merge = (newer: TraceBounds, older: TraceBounds): TraceBounds => ({
	startMs: Math.min(older.startMs, newer.startMs),
	endMs: Math.max(older.endMs, newer.endMs),
})

/**
 * Rows wholly before a tier are not seen, so a trace may start earlier: walk back one
 * pruned day at a time while the day below still holds rows of the trace (a span gap of
 * up to a day is bridged), down to `oldestMs`. A probe past its budget leaves the start
 * unknown, so the bounds then reach back to `oldestMs`: a read inside them may be slower,
 * but never misses a span in an unprobed older day.
 */
const extendBack = (
	traceId: string,
	bounds: TraceBounds,
	edgeMs: number,
	oldestMs: number,
): Effect.Effect<TraceBounds, WarehouseExecutorError, WarehouseExecutor> => {
	if (edgeMs <= oldestMs) return Effect.succeed(bounds)
	const below = { startMs: Math.max(oldestMs, edgeMs - DAY_MS), endMs: edgeMs }
	return probeWithinBudget(traceId, below).pipe(
		Effect.flatMap((hit) =>
			hit === OVER_BUDGET
				? Effect.as(Effect.annotateCurrentSpan("maple.query.trace_start_unbounded", true), {
						...bounds,
						startMs: oldestMs,
					})
				: Option.match(hit, {
						onNone: () => Effect.succeed(bounds),
						onSome: (older) => extendBack(traceId, merge(bounds, older), below.startMs, oldestMs),
					}),
		),
	)
}

/**
 * Where a lookup ended: the trace's bounds, a confirmed miss (every tier probed empty), or
 * incomplete, when a tier probe ran past its budget before the trace was found. Incomplete is
 * never a miss: the caller reads the whole lookback window instead.
 */
export type TraceLocation =
	| { readonly _tag: "Found"; readonly bounds: TraceBounds }
	| { readonly _tag: "Missing" }
	| { readonly _tag: "Incomplete" }

const MISSING: TraceLocation = { _tag: "Missing" }
const INCOMPLETE: TraceLocation = { _tag: "Incomplete" }

const probeTiers = (
	traceId: string,
	windows: ReadonlyArray<ProbeWindow>,
	oldestMs: number,
): Effect.Effect<TraceLocation, WarehouseExecutorError, WarehouseExecutor> => {
	const [head, ...rest] = windows
	if (head === undefined) return Effect.succeed(MISSING)
	// Over budget, the older (wider) tiers would be too: stop probing, but report no miss.
	return probeWithinBudget(traceId, head).pipe(
		Effect.flatMap((hit) =>
			hit === OVER_BUDGET
				? Effect.succeed(INCOMPLETE)
				: Option.match(hit, {
						onNone: () => probeTiers(traceId, rest, oldestMs),
						onSome: (bounds) =>
							Effect.map(
								extendBack(traceId, bounds, head.startMs, oldestMs),
								(found): TraceLocation => ({ _tag: "Found", bounds: found }),
							),
					}),
		),
	)
}

/**
 * Where a trace's spans are, from `trace_index` (written with the spans, so a trace it
 * does not hold is not stored). Tiers newest first, each pruned to its own days, stopping at
 * the first that holds the trace. A tier probe past its budget ends the lookup as incomplete;
 * one past it while walking back from a found trace widens its start to `oldestMs`.
 */
export const locateTrace = Effect.fn("Observability.locateTrace")(function* (
	traceId: string,
	opts: { readonly nowMs: number; readonly oldestMs: number },
) {
	const windows = traceProbeWindows(opts)
	const found = yield* probeTiers(traceId, windows, opts.oldestMs)
	yield* Effect.annotateCurrentSpan({
		"maple.query.probe_tiers": windows.length,
		"maple.query.trace_located": found._tag === "Found",
		"maple.query.trace_locate_incomplete": found._tag === "Incomplete",
	})
	return found
})
