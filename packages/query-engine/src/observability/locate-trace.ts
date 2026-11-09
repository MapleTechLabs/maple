import { Array as Arr, DateTime, Effect, Option } from "effect"
import * as CH from "../ch"
import { formatWarehouseDateTime } from "../datetime"
import { WarehouseExecutor, type WarehouseExecutorError } from "./WarehouseExecutor"

const HOUR_MS = 60 * 60 * 1000

/** `traces` and `trace_index` keep 30 days. */
export const TRACE_RETENTION_HOURS = 30 * 24

/** Probe tier edges, newest first: most lookups land in the last day or week. */
const PROBE_TIER_HOURS = [24, 7 * 24] as const

const DAY_MS = 24 * HOUR_MS

export interface ProbeWindow {
	readonly startMs: number
	/** Exclusive; `undefined` leaves the newest window open-ended. */
	readonly endMs: number | undefined
}

/**
 * Non-overlapping probe windows from now (open-ended) back to `oldestMs`, so a recent
 * trace costs a few partitions and a miss no more than one wide scan.
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

const merge = (newer: TraceBounds, older: TraceBounds): TraceBounds => ({
	startMs: Math.min(older.startMs, newer.startMs),
	endMs: Math.max(older.endMs, newer.endMs),
})

/**
 * Rows wholly before a tier are not seen, so a trace may start earlier: walk back one
 * pruned day at a time while the day below still holds rows of the trace (a span gap of
 * up to a day is bridged), down to `oldestMs`.
 */
const extendBack = (
	traceId: string,
	bounds: TraceBounds,
	edgeMs: number,
	oldestMs: number,
): Effect.Effect<TraceBounds, WarehouseExecutorError, WarehouseExecutor> => {
	if (edgeMs <= oldestMs) return Effect.succeed(bounds)
	const below = { startMs: Math.max(oldestMs, edgeMs - DAY_MS), endMs: edgeMs }
	return probeWindow(traceId, below).pipe(
		Effect.flatMap((hit) =>
			Option.match(hit, {
				onNone: () => Effect.succeed(bounds),
				onSome: (older) => extendBack(traceId, merge(bounds, older), below.startMs, oldestMs),
			}),
		),
	)
}

const probeTiers = (
	traceId: string,
	windows: ReadonlyArray<ProbeWindow>,
	oldestMs: number,
): Effect.Effect<Option.Option<TraceBounds>, WarehouseExecutorError, WarehouseExecutor> => {
	const [head, ...rest] = windows
	if (head === undefined) return Effect.succeedNone
	return probeWindow(traceId, head).pipe(
		Effect.flatMap((hit) =>
			Option.match(hit, {
				onNone: () => probeTiers(traceId, rest, oldestMs),
				onSome: (bounds) => Effect.asSome(extendBack(traceId, bounds, head.startMs, oldestMs)),
			}),
		),
	)
}

/**
 * Where a trace's spans are, from `trace_index` (written with the spans, so a trace it
 * does not hold is not stored). Tiers newest first, each pruned to its own days.
 */
export const locateTrace = Effect.fn("Observability.locateTrace")(function* (
	traceId: string,
	opts: { readonly nowMs: number; readonly oldestMs: number },
) {
	const windows = traceProbeWindows(opts)
	const found = yield* probeTiers(traceId, windows, opts.oldestMs)
	yield* Effect.annotateCurrentSpan({
		"maple.query.probe_tiers": windows.length,
		"maple.query.trace_located": Option.isSome(found),
	})
	return found
})
