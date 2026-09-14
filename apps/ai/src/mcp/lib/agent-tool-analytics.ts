import { optionalTimeParam } from "../tools/types"
import { AI_TOOLS_SELECTION_MAX_CHARS, AiToolErrorFingerprint } from "@maple/domain/http"
import { formatDurationFromMs, tableCell } from "./format"
import { optionalText } from "./limits"
import { Schema } from "effect"

// What `get_agent_tools_overview` and `get_agent_tool_error` share: the window,
// the selection, and the primitives both render with — a p95 that reads as ms in
// one tool and ns in the other is the drift this module prevents.

/** The window every tool-analytics read takes. 24h unless the agent narrows it. */
export const agentToolWindowParams = {
	start_time: optionalTimeParam("Start of the window (YYYY-MM-DD HH:mm:ss UTC). Default: 24h ago"),
	end_time: optionalTimeParam("End of the window (YYYY-MM-DD HH:mm:ss UTC). Default: now"),
}

/** A selection field, published with the ceiling its request class checks — so
 *  an over-long value is `Invalid parameters` rather than a silently shorter
 *  filter than the one the caller named. */
export const agentToolTextParam = (description: string) =>
	Schema.optional(Schema.String.check(Schema.isMaxLength(AI_TOOLS_SELECTION_MAX_CHARS))).annotate({
		description,
	})

/** The selection minus `tool`: one tool requires it, the other filters by it. */
export const agentToolSelectionParams = {
	model: agentToolTextParam(
		"Only calls attributed to this model (exact name, e.g. 'claude-sonnet-4'). A tool span carries no model of its own — it inherits its parent LLM call's, else its trace's",
	),
	service: agentToolTextParam("Only calls from this service (exact `service.name`)"),
	environment: agentToolTextParam("Only calls from this deployment environment (e.g. production)"),
	tool_contains: agentToolTextParam("Only tools whose name contains this text (case-insensitive)"),
}

type AgentToolSelectionInput = Schema.Struct.Type<typeof agentToolSelectionParams>

/** The selection as the request classes take it: renamed, blanks read as
 *  absent — a `Schema.Class` constructor THROWS on a value its checks refuse,
 *  so `""` from an LLM would be an opaque internal error. */
export const agentToolSelection = (params: AgentToolSelectionInput, tool: string | undefined) => ({
	tool,
	model: optionalText(params.model),
	service: optionalText(params.service),
	env: optionalText(params.environment),
	search: optionalText(params.tool_contains),
})

type AgentToolSelection = ReturnType<typeof agentToolSelection>

/** One line describing what the numbers below it cover. Every value is the
 *  caller's own free text, so it is collapsed like any other rendered cell. */
export const describeSelection = (selection: AgentToolSelection): string =>
	[
		`tool: ${selection.tool === undefined ? "all tools" : tableCell(selection.tool)}`,
		...(selection.model === undefined ? [] : [`model: ${tableCell(selection.model)}`]),
		...(selection.service === undefined ? [] : [`service: ${tableCell(selection.service)}`]),
		...(selection.env === undefined ? [] : [`environment: ${tableCell(selection.env)}`]),
		...(selection.search === undefined ? [] : [`name contains: ${tableCell(selection.search)}`]),
	].join(" · ")

/** A fingerprint reaches a UInt64 column comparison; anything else is a 400. */
export const decodeFingerprint = Schema.decodeUnknownOption(AiToolErrorFingerprint)

/** Every AI duration on the wire is nanoseconds; every rendered one is ms. */
export const formatNanos = (ns: number): string => formatDurationFromMs(ns / 1_000_000)

/** A value the emitter left empty reads as `—`, not as a blank cell; anything
 *  else is collapsed and pipe-escaped, so captured text cannot shift a column. */
export const orDash = (value: string, max?: number): string => (value === "" ? "—" : tableCell(value, max))

/** `2026-09-12 10:11:12` from a warehouse literal or an ISO bucket; `—` for `''`. */
export const formatSeen = (value: string): string =>
	value === "" ? "—" : value.replace("T", " ").slice(0, 19)

/** A capped list states which of the two its count is: the group's total, or
 *  the page the read returned. The totals are the overview's group row. */
export const pageCount = (rows: ReadonlyArray<unknown>, cap: number): string =>
	rows.length >= cap ? `first ${cap}` : `${rows.length}`

/** Buckets a trend is cut into, and the most any trend renders. */
export const TREND_BUCKETS = 24

/** A trend's failed calls per bucket, oldest first. The read returns only the
 *  buckets that had a failure, so a bare join of its points would read as
 *  consecutive — the grid is what makes a gap a `0`. Points are binned by
 *  instant against a start aligned DOWN to `toStartOfInterval`'s lattice, which
 *  keeps this independent of the ISO format the query emits. */
export const compactTrend = (
	points: ReadonlyArray<{ readonly bucket: string; readonly calls: number }>,
	opts: { readonly startMs: number; readonly endMs: number; readonly bucketSeconds: number },
): ReadonlyArray<number> => {
	const width = opts.bucketSeconds * 1000
	const gridStart = Math.floor(opts.startMs / width) * width
	const spanned = Math.ceil((opts.endMs - gridStart) / width)
	const buckets = Array.from<number>({ length: Math.min(spanned, TREND_BUCKETS) }).fill(0)
	for (const point of points) {
		const index = Math.floor((Date.parse(point.bucket) - gridStart) / width)
		if (index >= 0 && index < buckets.length) buckets[index] = point.calls
	}
	return buckets
}
