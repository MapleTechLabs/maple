import { AI_TOOLS_SELECTION_MAX_CHARS, AiToolErrorFingerprint } from "@maple/domain/http"
import type { AgentToolSelection } from "@maple/domain/mcp-outputs"
import { formatDurationFromMs, tableCell, truncate } from "./format"
import { MCP_SEARCH_MAX_HOURS } from "./time"
import * as P from "./params"
import { Schema } from "effect"

// What `get_agent_tools_overview` and `get_agent_tool_error` share: the window,
// the selection, and the primitives both render with: a p95 that reads as ms in
// one tool and ns in the other is the drift this module prevents.

/** The window every tool-analytics read takes. 24h unless the agent narrows it. */
export const AGENT_TOOL_WINDOW = P.timeWindow({ defaultHours: 24, maxHours: MCP_SEARCH_MAX_HOURS })

/** Optional text with the ceiling its request class checks, so an over-long value is a
 *  parameter error rather than a `Schema.Class` constructor throwing. Blank reads as absent. */
export const boundedText = (description: string, max: number) =>
	P.optionalText(description).pipe(
		Schema.decodeTo(Schema.optional(Schema.String.check(Schema.isMaxLength(max)))),
	)

/** A selection field, bounded like the tools page's own selection. */
export const agentToolTextParam = (description: string) =>
	boundedText(description, AI_TOOLS_SELECTION_MAX_CHARS)

/** The scope both tool-analytics tools take: which calls, by model, service and environment. */
export const agentToolScopeParams = {
	model: agentToolTextParam(
		"Only calls attributed to this model (exact name). A tool span inherits its parent LLM call's model, else its trace's",
	),
	service: agentToolTextParam("Only calls from this service (exact `service.name`)"),
	environment: agentToolTextParam("Only calls from this deployment environment (e.g. production, staging)"),
}

/** The selection minus `tool`: the overview filters tools by name, the error detail names one exactly. */
export const agentToolSelectionParams = {
	...agentToolScopeParams,
	tool_contains: agentToolTextParam("Only tools whose name contains this text (case-insensitive)"),
}

type AgentToolSelectionInput = Schema.Struct.Type<typeof agentToolScopeParams> & {
	readonly tool_contains?: string | undefined
}

/** The selection as the output echoes it; absent keys, never undefined ones. */
export const agentToolSelection = (
	params: AgentToolSelectionInput,
	tool: string | undefined,
): typeof AgentToolSelection.Type => ({
	...(tool === undefined ? undefined : { tool }),
	...(params.model === undefined ? undefined : { model: params.model }),
	...(params.service === undefined ? undefined : { service: params.service }),
	...(params.environment === undefined ? undefined : { environment: params.environment }),
	...(params.tool_contains === undefined ? undefined : { toolContains: params.tool_contains }),
})

/** The selection as the request classes take it. */
export const selectionRequest = (selection: typeof AgentToolSelection.Type) => ({
	tool: selection.tool,
	model: selection.model,
	service: selection.service,
	env: selection.environment,
	search: selection.toolContains,
})

/** The selection as the parameters that set it, for a next call. */
export const selectionArgs = (selection: typeof AgentToolSelection.Type) => ({
	...scopeArgs(selection),
	tool_contains: selection.toolContains,
})

/** The scope alone, for a `get_agent_tool_error` call: it names its tool exactly, so it takes no `tool_contains`. */
export const scopeArgs = (selection: typeof AgentToolSelection.Type) => ({
	model: selection.model,
	service: selection.service,
	environment: selection.environment,
})

/** One line describing what the numbers below it cover. Every value is the
 *  caller's own free text, so it is collapsed like any other rendered cell. */
export const describeSelection = (selection: typeof AgentToolSelection.Type): string =>
	[
		`tool: ${selection.tool === undefined ? "all tools" : tableCell(selection.tool)}`,
		...(selection.model === undefined ? [] : [`model: ${tableCell(selection.model)}`]),
		...(selection.service === undefined ? [] : [`service: ${tableCell(selection.service)}`]),
		...(selection.environment === undefined ? [] : [`environment: ${tableCell(selection.environment)}`]),
		...(selection.toolContains === undefined
			? []
			: [`name contains: ${tableCell(selection.toolContains)}`]),
	].join(" · ")

/** A fingerprint reaches a UInt64 column comparison; anything else is a 400. */
export const decodeFingerprint = Schema.decodeUnknownOption(AiToolErrorFingerprint)

/** Every AI duration on the wire is nanoseconds; every rendered one is ms. */
export const formatNanos = (ns: number): string => formatDurationFromMs(ns / 1_000_000)

/** A value the emitter left empty reads as `—`, not as a blank cell; anything
 *  else is collapsed and pipe-escaped, so captured text cannot shift a column. */
export const orDash = (value: string, max?: number): string => (value === "" ? "—" : tableCell(value, max))

/** The same for a `doc.table` cell, which the renderer collapses and escapes itself. */
export const cellOrDash = (value: string, max?: number): string =>
	value === "" ? "—" : max === undefined ? value : truncate(value, max)

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
