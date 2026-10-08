import { DateTime, Effect } from "effect"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"

/**
 * Literal `Timestamp` bounds, both inclusive, for the `narrowByTime` trace
 * builders. `trace_detail_spans` is partitioned by day and sorted by trace id,
 * so a by-id read seeks every partition its bounds leave in, and only literal
 * bounds leave any out.
 */
export interface TraceWindow {
	readonly startTime: string
	readonly endTime: string
}

export type TraceLookupStage = "hint" | "recent" | "retention"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Today and the two days before it, where nearly every by-id lookup lands. */
const RECENT_DAYS = 3
const OPEN_END = "2100-01-01 00:00:00"

export const recentTraceWindow = (nowMs: number): TraceWindow => ({
	startTime: formatWarehouseDateTime((Math.floor(nowMs / DAY_MS) - RECENT_DAYS + 1) * DAY_MS),
	endTime: OPEN_END,
})

/**
 * Whether rows read from the recent window are a whole trace: a root span is
 * among them, and a trace starts at its root. A root within an hour of the
 * window's start leaves room for clock skew, so it does not count.
 *
 * The one trace this reads short is an id reused under a second root days after
 * the first: its spans from before the recent window are left out.
 */
export const hasRootInside = (
	rows: ReadonlyArray<{ readonly parentSpanId: string; readonly startTime: DateTime.Utc }>,
	recent: TraceWindow,
): boolean => {
	const earliest = parseWarehouseDateTime(recent.startTime) + HOUR_MS
	return rows.some((row) => row.parentSpanId === "" && DateTime.toEpochMillis(row.startTime) >= earliest)
}

/**
 * Read a trace, or one span of it, by id without seeking every partition for
 * the common case: the hour around `hintMs` when the caller has a timestamp,
 * then the recent days, and only then the unbounded read (`read()` with no
 * window) that finds anything in retention.
 */
export const lookupByTraceId = Effect.fnUntraced(function* <A, E, R>(options: {
	readonly nowMs: number
	readonly hintMs?: number | undefined
	readonly read: (window?: TraceWindow) => Effect.Effect<ReadonlyArray<A>, E, R>
	/** Whether the recent window's rows are the whole answer. Defaults to "there are rows". */
	readonly whole?: (rows: ReadonlyArray<A>, recent: TraceWindow) => boolean
}) {
	const done = (rows: ReadonlyArray<A>, stage: TraceLookupStage) =>
		Effect.as(Effect.annotateCurrentSpan("maple.trace_lookup.stage", stage), { rows, stage })

	if (options.hintMs !== undefined) {
		const hinted = yield* options.read({
			startTime: formatWarehouseDateTime(options.hintMs - HOUR_MS),
			endTime: formatWarehouseDateTime(options.hintMs + HOUR_MS),
		})
		if (hinted.length > 0) return yield* done(hinted, "hint")
	}

	const recent = recentTraceWindow(options.nowMs)
	const recentRows = yield* options.read(recent)
	if (options.whole ? options.whole(recentRows, recent) : recentRows.length > 0) {
		return yield* done(recentRows, "recent")
	}

	return yield* done(yield* options.read(), "retention")
})
