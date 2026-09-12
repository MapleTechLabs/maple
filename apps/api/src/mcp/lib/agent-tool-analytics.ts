import { optionalBooleanParam, optionalStringParam, optionalTimeParam } from "@/mcp/tools/types"
import { formatDurationFromMs } from "@/mcp/lib/format"
import { toMcpQueryError, warehouseReadHandlers } from "@/mcp/lib/map-warehouse-error"
import { Effect } from "effect"

/**
 * Shared pieces of the three AI agent tool-analytics tools
 * (`get_agent_tools_overview`, `list_agent_tool_errors`, `get_agent_tool_error`).
 *
 * They read the same population under three groupings, so their window, their
 * selection and the way they render a nanosecond duration have to agree — a
 * p95 that reads as ms in one tool and ns in another is the kind of drift this
 * module exists to prevent.
 */

/**
 * Warehouse failures of a compiled read, as MCP query errors.
 *
 * `warehouseToMcpHandlers` is the whole-union table, which `catchTags` refuses
 * here: these reads compile their own SQL and never mint a raw-SQL token, so
 * the three token tags are not in their error channel.
 */
export const agentToolReadHandlers = (tool: string) =>
	warehouseReadHandlers((error) => Effect.fail(toMcpQueryError(tool)(error)))

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

/** snake_case parameters → the selection fields the request classes take. */
export const agentToolSelection = (params: AgentToolSelectionInput) => ({
	model: params.model,
	service: params.service,
	env: params.environment,
	search: params.search,
	failingOnly: params.failing_only,
})

/** The selection as the structured payload reports it back. */
export const agentToolSelectionData = (tool: string | undefined, params: AgentToolSelectionInput) => ({
	tool,
	model: params.model,
	service: params.service,
	environment: params.environment,
	search: params.search,
	failingOnly: params.failing_only,
})

/** One line describing what the numbers below it cover. */
export const describeSelection = (tool: string | undefined, params: AgentToolSelectionInput): string => {
	const parts = [
		`tool: ${tool ?? "all tools"}`,
		...(params.model === undefined ? [] : [`model: ${params.model}`]),
		...(params.service === undefined ? [] : [`service: ${params.service}`]),
		...(params.environment === undefined ? [] : [`environment: ${params.environment}`]),
		...(params.search === undefined ? [] : [`name contains: ${params.search}`]),
		...(params.failing_only === true ? ["failed calls only"] : []),
	]
	return parts.join(" · ")
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

/**
 * A trend's calls per bucket as a fixed-width grid, oldest last.
 *
 * The read returns only the buckets that had a failure, so a bare join of its
 * points would read as consecutive — the grid is what makes a gap a `0`. Points
 * are binned by instant rather than by their bucket string, which keeps this
 * independent of the ISO format the query emits.
 */
export const compactTrend = (
	points: ReadonlyArray<{ readonly bucket: string; readonly calls: number }>,
	opts: { readonly startMs: number; readonly endMs: number; readonly bucketSeconds: number },
	max = 24,
): ReadonlyArray<number> => {
	const width = opts.bucketSeconds * 1000
	const gridStart = Math.floor(opts.startMs / width) * width
	const buckets = Array.from<number>({
		length: Math.floor((opts.endMs - gridStart) / width) + 1,
	}).fill(0)
	for (const point of points) {
		// Every point is a bucket of this window snapped down by the same
		// interval, so it lands inside the grid the window spans.
		buckets[Math.floor((Date.parse(point.bucket) - gridStart) / width)] = point.calls
	}
	return buckets.slice(-max)
}
