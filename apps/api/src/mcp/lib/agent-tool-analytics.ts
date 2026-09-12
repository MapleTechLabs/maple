import { optionalBooleanParam, optionalStringParam, optionalTimeParam } from "@/mcp/tools/types"
import { formatDurationFromMs } from "@/mcp/lib/format"
import { Option } from "effect"

/**
 * Shared pieces of the three AI agent tool-analytics tools
 * (`get_agent_tools_overview`, `list_agent_tool_errors`, `get_agent_tool_error`).
 *
 * They read the same population under three groupings, so their window, their
 * selection and the way they render a nanosecond duration have to agree — a
 * p95 that reads as ms in one tool and ns in another is the kind of drift this
 * module exists to prevent.
 */

/** The window every tool-analytics read takes. 24h unless the agent narrows it. */
export const agentToolWindowParams = {
	start_time: optionalTimeParam("Start of the window (YYYY-MM-DD HH:mm:ss UTC). Default: 24h ago"),
	end_time: optionalTimeParam("End of the window (YYYY-MM-DD HH:mm:ss UTC). Default: now"),
}

/**
 * The selection, minus `tool` — which two of the three tools require and the
 * third takes as an optional filter, so each declares its own.
 *
 * `model`, `service` and `environment` are exact matches on values
 * `get_agent_tools_overview`'s breakdown and `get_agent_sessions_overview`'s
 * facets produce; `search` and `failing_only` are predicates over the whole
 * population.
 */
export const agentToolSelectionParams = {
	model: optionalStringParam(
		"Only calls attributed to this model (exact name, e.g. 'claude-sonnet-4'). A tool span carries no model of its own — it inherits its parent LLM call's, else its trace's",
	),
	service: optionalStringParam("Only calls from this service (exact `service.name`)"),
	environment: optionalStringParam("Only calls from this deployment environment (e.g. production)"),
	search: optionalStringParam("Only tools whose name contains this text (case-insensitive)"),
	failing_only: optionalBooleanParam("Only calls whose span failed (default false)"),
}

export interface AgentToolSelectionInput {
	readonly model?: string
	readonly service?: string
	readonly environment?: string
	readonly search?: string
	readonly failing_only?: boolean
}

/** What the domain's selection fields take: 1–200 characters. */
const SELECTION_CHARS = 200

/** `session` is the one selection value with a wider ceiling. */
export const SESSION_SELECTION_CHARS = 400

/**
 * A filter as the request classes will take it: trimmed, blank → absent,
 * clipped to the schema's own ceiling.
 *
 * LLM callers send `""` to mean "no filter", and every request here is a
 * `Schema.Class` — its constructor THROWS on a value the checks refuse, so an
 * empty or over-long string surfaced as an opaque internal error instead of
 * either a filter or a `validationError`. Clipping rather than refusing is
 * deliberate for the free-text fields: a truncated substring match still
 * answers the caller's question.
 */
export const selectionValue = (
	value: string | undefined,
	max: number = SELECTION_CHARS,
): string | undefined => {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	return trimmed === "" ? undefined : trimmed.slice(0, max)
}

/** snake_case parameters → the selection fields the request classes take. */
export const agentToolSelection = (params: AgentToolSelectionInput) => ({
	model: selectionValue(params.model),
	service: selectionValue(params.service),
	env: selectionValue(params.environment),
	search: selectionValue(params.search),
	failingOnly: params.failing_only,
})

/** The selection as the structured payload reports it back. */
export const agentToolSelectionData = (tool: string | undefined, params: AgentToolSelectionInput) => {
	const selection = agentToolSelection(params)
	return {
		tool,
		model: selection.model,
		service: selection.service,
		environment: selection.env,
		search: selection.search,
		failingOnly: selection.failingOnly,
	}
}

/** One line describing what the numbers below it cover. */
export const describeSelection = (tool: string | undefined, params: AgentToolSelectionInput): string => {
	const selection = agentToolSelection(params)
	const parts = [
		`tool: ${tool ?? "all tools"}`,
		...(selection.model === undefined ? [] : [`model: ${selection.model}`]),
		...(selection.service === undefined ? [] : [`service: ${selection.service}`]),
		...(selection.env === undefined ? [] : [`environment: ${selection.env}`]),
		...(selection.search === undefined ? [] : [`name contains: ${selection.search}`]),
		...(selection.failingOnly === true ? ["failed calls only"] : []),
	]
	return parts.join(" · ")
}

/**
 * `bucket_seconds` as the reads will take it: whole seconds, at least one and
 * at most the window's own width.
 *
 * `BucketSeconds` refuses a fraction but accepts any positive integer, so
 * `1e21` reached `toStartOfInterval` as an interval literal; and a bucket wider
 * than the window is one point that describes nothing.
 */
export const parseBucketSeconds = (value: number, windowSeconds: number): Option.Option<number> => {
	const seconds = Math.floor(value)
	return Number.isFinite(seconds) && seconds >= 1 && seconds <= windowSeconds
		? Option.some(seconds)
		: Option.none()
}

/** Every AI duration on the wire is nanoseconds; every rendered one is ms. */
export const formatNanos = (ns: number): string => formatDurationFromMs(ns / 1_000_000)

/**
 * Percent change against the comparison window, or `—` where that window
 * measured nothing: a delta against zero is not a percentage.
 */
export const formatDelta = (current: number, previous: number): string => {
	if (previous === 0) return "—"
	const change = ((current - previous) / previous) * 100
	return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`
}

/** A share, or `—` where the denominator is zero. */
export const formatRate = (part: number, whole: number): string =>
	whole === 0 ? "—" : `${((part / whole) * 100).toFixed(2)}%`

/** `2026-09-12 10:11:12` from a warehouse literal or an ISO bucket; `—` for `''`. */
export const formatSeen = (value: string): string =>
	value === "" ? "—" : value.replace("T", " ").slice(0, 19)

/** Buckets a default trend is cut into, and the most any trend renders. */
export const TREND_BUCKETS = 24

/**
 * A trend's calls per bucket as a fixed-width grid, oldest first.
 *
 * The read returns only the buckets that had a failure, so a bare join of its
 * points would read as consecutive — the grid is what makes a gap a `0`. Points
 * are binned by instant rather than by their bucket string, which keeps this
 * independent of the ISO format the query emits.
 *
 * Only the newest `TREND_BUCKETS` are rendered, and only those are allocated:
 * the window's end is exclusive (a window a whole number of buckets wide spans
 * exactly that many, not one more, so its first bucket survives the cut), and
 * `bucket_seconds=1` over a week is 24 slots per group rather than 604 801.
 */
export const compactTrend = (
	points: ReadonlyArray<{ readonly bucket: string; readonly calls: number }>,
	opts: { readonly startMs: number; readonly endMs: number; readonly bucketSeconds: number },
): ReadonlyArray<number> => {
	const width = opts.bucketSeconds * 1000
	// Aligned to the lattice `toStartOfInterval` snaps the query's buckets to,
	// which is what lets a point be binned by its instant. The grid is
	// arithmetic over caller-supplied bounds, so a non-finite one would reach
	// `Array.from` as a length.
	const firstBucket = Math.floor(opts.startMs / width) * width
	const spanned = Math.ceil((opts.endMs - firstBucket) / width)
	if (!Number.isFinite(spanned) || spanned < 1) return []
	const length = Math.min(spanned, TREND_BUCKETS)
	const gridStart = firstBucket + (spanned - length) * width
	const buckets = Array.from<number>({ length }).fill(0)
	for (const point of points) {
		const index = Math.floor((Date.parse(point.bucket) - gridStart) / width)
		if (index >= 0 && index < length) buckets[index] = point.calls
	}
	return buckets
}
