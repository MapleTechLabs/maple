import {
	MAX_DISCOVERY_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_LOG_PATTERN_RANGE_SECONDS,
	parseWarehouseDateTime,
	warehouseDateTime,
	type WarehouseDateTime,
} from "@maple/query-engine"

// Tool-facing caps, expressed in hours to match `ResolveTimeRangeOptions`. The
// underlying values live in `@maple/query-engine`'s limits module so the MCP
// surface, the v2 API, and the query engine itself can't drift apart.

/** Raw-row search tools (traces, logs, sessions, slow traces, top operations). */
export const MCP_SEARCH_MAX_HOURS = MAX_LIST_RANGE_SECONDS / 3600
/** Rollup-backed discovery tools (metric listing, attribute exploration). */
export const MCP_DISCOVERY_MAX_HOURS = MAX_DISCOVERY_RANGE_SECONDS / 3600
/** Log-pattern clustering — scans raw message bodies. */
export const MCP_LOG_PATTERN_MAX_HOURS = MAX_LOG_PATTERN_RANGE_SECONDS / 3600

const DEFAULT_HOURS = 6

export interface ResolveTimeRangeOptions {
	/** Default window when the agent supplies neither bound. Defaults to 6h. */
	readonly defaultHours?: number
	/** Maximum allowed window. A wider agent-supplied range is reported as `exceeded`. */
	readonly maxHours?: number
}

export interface ResolvedTimeRange {
	readonly st: WarehouseDateTime
	readonly et: WarehouseDateTime
	/** True when the agent-supplied range is wider than `maxHours`. */
	readonly exceeded: boolean
	/** The `maxHours` cap that applies (if any). Included so callers can surface it. */
	readonly maxHours: number | undefined
	/** Width of the resolved window in hours. */
	readonly requestedHours: number
}

/**
 * Resolves the time range for an MCP tool call, falling back to a default window
 * for bounds the agent didn't supply.
 *
 * Both bounds are {@link WarehouseDateTime}, so this function has no parsing to
 * do and no malformed case to handle: `P.timeWindow` decoded and
 * canonicalized them at the tool's parameter boundary, or the call didn't
 * typecheck. That is the whole reason the brand exists — a tool cannot reach
 * this function with a raw string it forgot to validate.
 *
 * When `maxHours` is set and the resolved window is wider, the range is returned
 * *unchanged* with `exceeded: true`. Tool windows go through {@link resolveWindow},
 * which clamps against the server clock and reports every adjustment.
 *
 * Back-compat: the third arg also accepts a bare number (treated as `defaultHours`).
 */
export function resolveTimeRange(
	startTime: WarehouseDateTime | undefined,
	endTime: WarehouseDateTime | undefined,
	opts: ResolveTimeRangeOptions | number = {},
): ResolvedTimeRange {
	const { defaultHours = DEFAULT_HOURS, maxHours } =
		typeof opts === "number" ? { defaultHours: opts, maxHours: undefined } : opts

	const et = endTime ?? warehouseDateTime(Date.now())
	const st = startTime ?? warehouseDateTime(parseWarehouseDateTime(et) - defaultHours * 3_600_000)

	const requestedHours = (parseWarehouseDateTime(et) - parseWarehouseDateTime(st)) / 3_600_000

	const exceeded = maxHours !== undefined && maxHours > 0 && requestedHours > maxHours

	return { st, et, exceeded, maxHours, requestedHours }
}

const formatHours = (hours: number): string => {
	const rounded = Math.round(hours * 10) / 10
	if (rounded >= 24 && rounded % 24 === 0) {
		const days = rounded / 24
		return `${days} day${days === 1 ? "" : "s"}`
	}
	return `${rounded} hour${rounded === 1 ? "" : "s"}`
}

/** Clock skew tolerated on a future end_time before it earns a notice (it is clamped either way). */
const FUTURE_END_TOLERANCE_MS = 60_000
/** Windows narrower than this get a warning: a near-empty window reads like "nothing happened". */
const SHORT_WINDOW_MS = 60_000

export type WindowResolution =
	| {
			readonly _tag: "Resolved"
			readonly st: WarehouseDateTime
			readonly et: WarehouseDateTime
			readonly now: WarehouseDateTime
			/** How the window differs from what was asked, for the model to read. */
			readonly notices: ReadonlyArray<string>
	  }
	| { readonly _tag: "Rejected"; readonly message: string }

/**
 * The window a time-windowed tool queries, relative to the server clock `nowMs`. A future
 * end_time clamps to now, a start_time not in the past is rejected, and a window over
 * `maxHours` keeps end_time and moves start_time forward. Every adjustment returns a notice.
 */
export function resolveWindow(
	startTime: WarehouseDateTime | undefined,
	endTime: WarehouseDateTime | undefined,
	spec: ResolveTimeRangeOptions & { readonly tool: string },
	nowMs: number,
): WindowResolution {
	const now = warehouseDateTime(nowMs)
	const notices: Array<string> = []
	const startMs = startTime === undefined ? undefined : parseWarehouseDateTime(startTime)
	if (startMs !== undefined && startMs >= nowMs) {
		return {
			_tag: "Rejected",
			message: `start_time (${startTime}) is not in the past: server now is ${now} UTC. Times are UTC; convert local times before querying.`,
		}
	}
	let endMs = endTime === undefined ? nowMs : parseWarehouseDateTime(endTime)
	if (endTime !== undefined && endMs > nowMs) {
		if (endMs - nowMs > FUTURE_END_TOLERANCE_MS) {
			notices.push(
				`end_time ${endTime} is in the future; clamped to server now (${now} UTC). Times are UTC.`,
			)
		}
		endMs = nowMs
	}
	const et = warehouseDateTime(endMs)
	let st = startTime ?? warehouseDateTime(endMs - (spec.defaultHours ?? DEFAULT_HOURS) * 3_600_000)
	const widthMs = endMs - parseWarehouseDateTime(st)
	if (widthMs <= 0) {
		const clamped = endTime !== undefined && et !== endTime ? " (end_time was clamped to server now)" : ""
		return {
			_tag: "Rejected",
			message: `start_time (${st}) is ${widthMs === 0 ? "equal to" : "after"} end_time (${et})${clamped}.`,
		}
	}
	const { maxHours } = spec
	if (maxHours !== undefined && maxHours > 0 && widthMs > maxHours * 3_600_000) {
		st = warehouseDateTime(endMs - maxHours * 3_600_000)
		notices.push(
			`Requested ${formatHours(widthMs / 3_600_000)}, but \`${spec.tool}\` covers at most ${formatHours(maxHours)}: start_time moved to ${st}, end_time kept. Query the earlier part with a separate call.`,
		)
	} else if (widthMs < SHORT_WINDOW_MS) {
		notices.push(
			`The window is only ${Math.round(widthMs / 1000)}s wide (${st} to ${et}); an empty result here does not mean nothing happened. Times are UTC.`,
		)
	}
	return { _tag: "Resolved", st, et, now, notices }
}
