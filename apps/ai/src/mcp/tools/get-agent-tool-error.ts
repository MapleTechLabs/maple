import { optionalNumberParam, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import {
	agentToolSelection,
	agentToolSelectionParams,
	agentToolWindowParams,
	decodeFingerprint,
	describeSelection,
	formatNanos,
	formatSeen,
	orDash,
	pageCount,
} from "../lib/agent-tool-analytics"
import { windowHint } from "../lib/agent-sessions"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "../lib/time"
import { clampLimit, optionalText } from "../lib/limits"
import { fencedBlock, formatNumber, formatTable, tableCell } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import {
	readAiToolErrorDetail,
	readAiToolErrorSamples,
} from "@maple/backend/services/ai-sessions/ai-session-reads"
import {
	AI_TOOL_ERROR_SESSION_MAX_CHARS,
	AI_TOOLS_SELECTION_MAX_CHARS,
	AiToolErrorDetailRequest,
	AiToolErrorSamplesRequest,
} from "@maple/domain/http"
import {
	AI_TOOL_ERROR_PAYLOAD_MAX,
	AI_TOOL_ERROR_SESSIONS_LIMIT,
	AI_TOOL_ERROR_VARIANTS_LIMIT,
} from "@maple/query-engine-integrations/ai"
import { Effect, Option, Schema } from "effect"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"

const encoder = new TextEncoder()

/**
 * A payload as the caller asked to see it, with its true size beside it.
 *
 * Two cuts reach it — the SQL's {@link AI_TOOL_ERROR_PAYLOAD_MAX} and the
 * caller's `payload_chars` — so the ellipsis follows from the bytes the row
 * reports against the bytes rendered, which covers both. `retained` is whether
 * the span behind the sample was read at all: without it an argument that was
 * genuinely empty reads as a payload nobody kept.
 */
const samplePayload = (text: string, chars: number, bytes: number, retained: boolean): string => {
	if (text === "") return retained ? "(empty)" : "(not available — the span was not retained)"
	const shown = text.slice(0, chars)
	const cut = bytes > encoder.encode(shown).length
	return `${shown}${cut ? "…" : ""}\n(${formatNumber(bytes)} bytes total)`
}

export function registerGetAgentToolErrorTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_tool_error",
		"One failure group of an AI agent tool call (the tools an LLM agent invokes during a session — not browser sessions and not Maple's own MCP tools): which sessions hit it, which message variants it folded, which models and services it happens under, and sample calls with the arguments they were made with and the results that came back. `tool` is an exact tool name from `get_agent_tools_overview`'s breakdown and `fingerprint` comes from the failure groups `get_agent_tools_overview` lists for a selected tool.",
		Schema.Struct({
			...agentToolWindowParams,
			tool: requiredStringParam("The failing tool (exact `gen_ai.tool.name`)").check(
				Schema.isMaxLength(AI_TOOLS_SELECTION_MAX_CHARS),
			),
			fingerprint: requiredStringParam(
				"The error group, as `get_agent_tools_overview` reported it for this tool (a decimal number)",
			),
			...agentToolSelectionParams,
			samples_session: Schema.optional(
				Schema.String.check(Schema.isMaxLength(AI_TOOL_ERROR_SESSION_MAX_CHARS)),
			).annotate({
				description:
					"Only samples from this session id. It narrows the Samples section alone — the sessions, variants and where-it-fails tables still cover the whole group",
			}),
			samples_limit: optionalNumberParam("Max sample calls to return (default 10, max 100)"),
			payload_chars: optionalNumberParam(
				`Max characters of each argument/result block (default 800, max ${AI_TOOL_ERROR_PAYLOAD_MAX}, which is what the read keeps of a payload)`,
			),
		}),
		Effect.fn("McpTool.getAgentToolError")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "get_agent_tool_error")
			const fingerprint = decodeFingerprint(params.fingerprint)
			if (Option.isNone(fingerprint)) {
				return validationError(
					`Invalid fingerprint: '${params.fingerprint}'. It is the decimal number \`get_agent_tools_overview tool="<tool>"\` prints in its Fingerprint column.`,
					`get_agent_tool_error tool="search_docs" fingerprint="10453282193948324021"`,
				)
			}
			const tool = optionalText(params.tool)
			if (tool === undefined) {
				return validationError(
					"Invalid tool: a tool name is required. It is an exact `gen_ai.tool.name`, as `get_agent_tools_overview` lists it in its breakdown.",
					`get_agent_tool_error tool="search_docs" fingerprint="${params.fingerprint}"`,
				)
			}
			const sessionFilter = optionalText(params.samples_session)
			const samplesLimit = clampLimit(params.samples_limit, { defaultValue: 10, max: 100 })
			const payloadChars = clampLimit(params.payload_chars, {
				defaultValue: 800,
				max: AI_TOOL_ERROR_PAYLOAD_MAX,
			})
			const selection = agentToolSelection(params, tool)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				tool,
				fingerprint: fingerprint.value,
				limit: samplesLimit,
			})

			const scope = { startTime: st, endTime: et, ...selection, tool, fingerprint: fingerprint.value }
			const [detail, samples] = yield* Effect.all(
				[
					readAiToolErrorDetail(tenant, new AiToolErrorDetailRequest(scope)),
					readAiToolErrorSamples(
						tenant,
						new AiToolErrorSamplesRequest({
							...scope,
							limit: samplesLimit,
							...(sessionFilter !== undefined && { session: sessionFilter }),
						}),
					),
				],
				{ concurrency: 2 },
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_tool_error")))

			yield* Effect.annotateCurrentSpan({
				"result.rowCount": samples.occurrences.length,
				"result.hasMore": samples.nextCursor !== undefined,
			})

			const lines: string[] = [
				`## Tool failure group ${fingerprint.value}`,
				`Tool: ${tableCell(tool)}`,
				`Time range: ${st} — ${et}`,
				`Selection: ${describeSelection(selection)}`,
				``,
			]

			if (detail.sessions.length === 0 && samples.occurrences.length === 0) {
				lines.push(
					`No failed calls of \`${tableCell(tool)}\` under this fingerprint in the window.`,
					formatNextSteps([
						`\`get_agent_tools_overview tool=${JSON.stringify(tool)}\` — the groups that exist in this window (a fingerprint is only visible while its failures are in range)`,
					]),
				)
				return { content: [{ type: "text" as const, text: lines.join("\n") }] }
			}

			if (detail.sessions.length > 0) {
				lines.push(
					`### Sessions (${pageCount(detail.sessions, AI_TOOL_ERROR_SESSIONS_LIMIT)}, most hits first)`,
					formatTable(
						["Session", "Vendor", "Agent", "Service", "Hits", "Last seen"],
						detail.sessions.map((row) => [
							tableCell(row.sessionId),
							orDash(row.vendorId),
							orDash(row.agentName, 40),
							orDash(row.service),
							formatNumber(row.hits),
							formatSeen(row.lastSeen),
						]),
					),
					...(detail.sessions.length < AI_TOOL_ERROR_SESSIONS_LIMIT
						? []
						: [
								`The read stops at ${AI_TOOL_ERROR_SESSIONS_LIMIT} sessions, so more may have hit this group; its true count is the Sessions column of \`get_agent_tools_overview tool=${JSON.stringify(tool)}\`.`,
							]),
					``,
				)
			}
			if (detail.variants.length > 0) {
				lines.push(
					`### Message variants (${pageCount(detail.variants, AI_TOOL_ERROR_VARIANTS_LIMIT)}, most calls first)`,
					formatTable(
						["Calls", "Last seen", "Message"],
						detail.variants.map((row) => [
							formatNumber(row.calls),
							formatSeen(row.lastSeen),
							tableCell(row.message, 200),
						]),
					),
					...(detail.variants.length < AI_TOOL_ERROR_VARIANTS_LIMIT
						? []
						: [
								`The read stops at ${AI_TOOL_ERROR_VARIANTS_LIMIT} variants, so the group may have folded more; its true count is the Variants column of \`get_agent_tools_overview tool=${JSON.stringify(tool)}\`.`,
							]),
					``,
				)
			}
			if (detail.breakdown.length > 0) {
				lines.push(
					`### Where it fails`,
					formatTable(
						["Model", "Service", "Calls"],
						detail.breakdown.map((row) => [
							row.model === "" ? "(unattributed)" : tableCell(row.model),
							orDash(row.service),
							formatNumber(row.calls),
						]),
					),
					``,
				)
			}
			lines.push(
				`### Samples (${samples.occurrences.length}, newest first${
					sessionFilter === undefined ? "" : `, session ${tableCell(sessionFilter)} only`
				})`,
			)

			for (const sample of samples.occurrences) {
				const retained = sample.retained
				lines.push(
					``,
					`**${formatSeen(sample.timestamp)}** · session \`${tableCell(sample.sessionId)}\` · agent ${orDash(sample.agentName)} · model ${sample.model === "" ? "(unattributed)" : tableCell(sample.model)} · service ${orDash(sample.service)}`,
					`duration ${formatNanos(sample.durationNs)} · status ${orDash(sample.statusCode)} · error.type ${orDash(sample.errorType)}`,
					`trace \`${tableCell(sample.traceId)}\` span \`${tableCell(sample.spanId)}\``,
					`Message: ${orDash(sample.message, 400)}`,
					`Arguments:`,
					fencedBlock(
						samplePayload(sample.arguments, payloadChars, sample.argumentsBytes, retained),
					),
					`Result:`,
					fencedBlock(samplePayload(sample.result, payloadChars, sample.resultBytes, retained)),
				)
			}
			if (samples.nextCursor !== undefined) {
				lines.push(
					``,
					`More samples exist past this page — raise samples_limit, or narrow with samples_session="…".`,
				)
			}

			const firstSession = detail.sessions[0]
			const firstSample = samples.occurrences[0]
			// The bounds a session read seeks on, padded around the failure the way
			// a list row's are — the sibling tool asks for them, and this answer
			// holds the only instant that can supply them.
			const sessionBounds =
				firstSample === undefined
					? ""
					: ` ${windowHint({ startTime: firstSample.timestamp, endTime: firstSample.timestamp })}`
			lines.push(
				formatNextSteps([
					...(firstSession === undefined
						? []
						: [
								`\`get_agent_session session_id=${JSON.stringify(firstSession.sessionId)}${sessionBounds}\` — the session that hit this group most`,
							]),
					...(firstSample === undefined
						? []
						: [
								`\`inspect_span trace_id=${JSON.stringify(firstSample.traceId)} span_id=${JSON.stringify(
									firstSample.spanId,
								)} timestamp="${warehouseDateTimeToIso(
									firstSample.timestamp,
								)}"\` — the failed call in full`,
							]),
				]),
			)

			return { content: [{ type: "text" as const, text: lines.join("\n") }] }
		}),
	)
}
