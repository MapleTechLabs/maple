import { Array as Arr, DateTime, Effect, Option } from "effect"
import * as CH from "../ch"
import { formatWarehouseDateTime } from "../datetime"
import { WarehouseExecutor, type WarehouseExecutorError } from "./WarehouseExecutor"

const HOUR_MS = 60 * 60 * 1000

/** `traces` and `trace_index` keep 30 days. */
export const TRACE_RETENTION_HOURS = 30 * 24

/** Probe tier edges, newest first: most lookups land in the last day or week. */
const PROBE_TIER_HOURS = [24, 7 * 24] as const

/** How far below a hit's tier edge the trace's earlier spans are looked for. */
const EDGE_SLACK_MS = 24 * HOUR_MS

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

const merge = (newer: TraceBounds, older: Option.Option<TraceBounds>): TraceBounds =>
	Option.match(older, {
		onNone: () => newer,
		onSome: (o) => ({
			startMs: Math.min(o.startMs, newer.startMs),
			endMs: Math.max(o.endMs, newer.endMs),
		}),
	})

const probeTiers = (
	traceId: string,
	windows: ReadonlyArray<ProbeWindow>,
): Effect.Effect<Option.Option<TraceBounds>, WarehouseExecutorError, WarehouseExecutor> => {
	const [head, ...rest] = windows
	if (head === undefined) return Effect.succeedNone
	return probeWindow(traceId, head).pipe(
		Effect.flatMap((hit) => {
			if (Option.isNone(hit)) return probeTiers(traceId, rest)
			// Rows wholly before the tier are not seen, so the trace may start earlier: read the
			// day just below the edge too, which covers a gap between spans of up to a day.
			const [older] = rest
			if (older === undefined) return Effect.succeed(hit)
			const below = {
				startMs: Math.max(older.startMs, head.startMs - EDGE_SLACK_MS),
				endMs: head.startMs,
			}
			return probeWindow(traceId, below).pipe(Effect.map((o) => Option.some(merge(hit.value, o))))
		}),
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
	const found = yield* probeTiers(traceId, windows)
	yield* Effect.annotateCurrentSpan({
		"maple.query.probe_tiers": windows.length,
		"maple.query.trace_located": Option.isSome(found),
	})
	return found
})
