import {
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import {
	agentToolSelection,
	agentToolSelectionData,
	agentToolSelectionParams,
	agentToolWindowParams,
	describeSelection,
	formatNanos,
	formatSeen,
	selectionValue,
	SESSION_SELECTION_CHARS,
} from "@/mcp/lib/agent-tool-analytics"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS, rangeExceededResult, resolveTimeRange } from "@/mcp/lib/time"
import { clampLimit } from "@/mcp/lib/limits"
import { formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { readAiToolErrorDetail, readAiToolErrorSamples } from "@/services/ai-sessions/ai-session-reads"
import {
	AiToolErrorDetailRequest,
	AiToolErrorFingerprint,
	AiToolErrorSamplesRequest,
} from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

const decodeFingerprint = Schema.decodeUnknownOption(AiToolErrorFingerprint)

/**
 * A payload as the caller asked to see it, with its true size beside it — the
 * read already truncated it once, so the byte count is the only thing that says
 * how much of the argument or result is missing.
 *
 * Not `clipPayload` from `lib/agent-sessions`: that one measures the text it is
 * handed, which here is already the read's truncation rather than the span's
 * own payload, so the size has to come from the row.
 */
const samplePayload = (text: string, chars: number, bytes: number): string => {
	if (text === "") return "(not available — the span was not retained)"
	const clipped = text.length <= chars ? text : `${text.slice(0, chars)}…`
	return `${clipped}\n(${formatNumber(bytes)} bytes total)`
}

export function registerGetAgentToolErrorTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_tool_error",
		"One failure group of an AI agent tool call (the tools an LLM agent invokes during a session — not browser sessions and not Maple's own MCP tools): which sessions hit it, which message variants it folded, which models and services it happens under, and sample calls with the arguments they were made with and the results that came back. `tool` is an exact tool name from `get_agent_tools_overview`'s breakdown and `fingerprint` comes from the failure groups `get_agent_tools_overview` lists for a selected tool.",
		Schema.Struct({
			...agentToolWindowParams,
			tool: requiredStringParam("The failing tool (exact `gen_ai.tool.name`)"),
			fingerprint: requiredStringParam(
				"The error group, as `get_agent_tools_overview` reported it for this tool (a decimal number)",
			),
			...agentToolSelectionParams,
			session: optionalStringParam("Only samples from this session id"),
			samples_limit: optionalNumberParam("Max sample calls to return (default 10, max 100)"),
			payload_chars: optionalNumberParam(
				"Max characters of each argument/result block (default 800, max 10000)",
			),
		}),
		Effect.fn("McpTool.getAgentToolError")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: 24,
				maxHours: MCP_SEARCH_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "get_agent_tool_error")
			// The fingerprint reaches a UInt64 column comparison, so anything else
			// is refused here rather than as a warehouse error.
			const fingerprint = decodeFingerprint(params.fingerprint)
			if (Option.isNone(fingerprint)) {
				return validationError(
					`Invalid fingerprint: '${params.fingerprint}'. It is the decimal number \`get_agent_tools_overview tool="<tool>"\` prints in its Fingerprint column.`,
					`get_agent_tool_error tool="search_docs" fingerprint="10453282193948324021"`,
				)
			}
			const tool = selectionValue(params.tool)
			if (tool === undefined) {
				return validationError(
					"Invalid tool: a tool name is required. It is an exact `gen_ai.tool.name`, as `get_agent_tools_overview` lists it in its breakdown.",
					`get_agent_tool_error tool="search_docs" fingerprint="${params.fingerprint}"`,
				)
			}
			const sessionFilter = selectionValue(params.session, SESSION_SELECTION_CHARS)
			const samplesLimit = clampLimit(params.samples_limit, { defaultValue: 10, max: 100 })
			const payloadChars = clampLimit(params.payload_chars, { defaultValue: 800, max: 10_000 })
			const selection = { ...agentToolSelection(params), tool }
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				tool,
				fingerprint: fingerprint.value,
				samplesLimit,
			})

			const [detail, samples] = yield* Effect.all(
				[
					readAiToolErrorDetail(
						tenant,
						new AiToolErrorDetailRequest({
							startTime: st,
							endTime: et,
							fingerprint: fingerprint.value,
							...selection,
						}),
					),
					readAiToolErrorSamples(
						tenant,
						new AiToolErrorSamplesRequest({
							startTime: st,
							endTime: et,
							fingerprint: fingerprint.value,
							limit: samplesLimit,
							...(sessionFilter !== undefined && { session: sessionFilter }),
							...selection,
						}),
					),
				],
				{ concurrency: 2 },
			).pipe(Effect.catchTags(warehouseReadToMcpHandlers("get_agent_tool_error")))

			yield* Effect.annotateCurrentSpan({
				"result.rowCount": samples.occurrences.length,
				"maple.ai.tools.has_more": samples.nextCursor !== undefined,
			})

			const lines: string[] = [
				`## Tool failure group ${fingerprint.value}`,
				`Tool: ${tool}`,
				`Time range: ${st} — ${et}`,
				`Selection: ${describeSelection(tool, params)}`,
				``,
			]

			if (detail.sessions.length === 0 && samples.occurrences.length === 0) {
				lines.push(
					`No failed calls of \`${tool}\` under this fingerprint in the window.`,
					formatNextSteps([
						`\`get_agent_tools_overview tool="${tool}"\` — the groups that exist in this window (a fingerprint is only visible while its failures are in range)`,
					]),
				)
				return {
					content: createDualContent(lines.join("\n"), {
						tool: "get_agent_tool_error",
						data: {
							timeRange: { start: st, end: et },
							selection: agentToolSelectionData(tool, params),
							fingerprint: fingerprint.value,
							sessions: [],
							variants: [],
							breakdown: [],
							samples: [],
							hasMoreSamples: false,
						},
					}),
				}
			}

			lines.push(
				`### Sessions (${detail.sessions.length}, most hits first)`,
				formatTable(
					["Session", "Vendor", "Agent", "Service", "Hits", "Last seen"],
					detail.sessions.map((session) => [
						session.sessionId,
						session.vendorId === "" ? "—" : session.vendorId,
						session.agentName === "" ? "—" : truncate(session.agentName, 40),
						session.service === "" ? "—" : session.service,
						formatNumber(session.hits),
						formatSeen(session.lastSeen),
					]),
				),
				``,
				`### Message variants (${detail.variants.length})`,
				formatTable(
					["Calls", "Last seen", "Message"],
					detail.variants.map((variant) => [
						formatNumber(variant.calls),
						formatSeen(variant.lastSeen),
						truncate(variant.message.replace(/\s+/g, " "), 200),
					]),
				),
				``,
				`### Where it fails`,
				formatTable(
					["Model", "Service", "Calls"],
					detail.breakdown.map((row) => [
						row.model === "" ? "(unattributed)" : row.model,
						row.service === "" ? "—" : row.service,
						formatNumber(row.calls),
					]),
				),
				``,
				`### Samples (${samples.occurrences.length}, newest first)`,
			)

			for (const sample of samples.occurrences) {
				lines.push(
					``,
					`**${formatSeen(sample.timestamp)}** · session \`${sample.sessionId}\` · agent ${sample.agentName === "" ? "—" : sample.agentName} · model ${sample.model === "" ? "(unattributed)" : sample.model} · service ${sample.service === "" ? "—" : sample.service}`,
					`duration ${formatNanos(sample.durationNs)} · status ${sample.statusCode === "" ? "—" : sample.statusCode} · error.type ${sample.errorType === "" ? "—" : sample.errorType}`,
					`trace \`${sample.traceId}\` span \`${sample.spanId}\``,
					`Message: ${sample.message === "" ? "—" : truncate(sample.message.replace(/\s+/g, " "), 400)}`,
					`Arguments:`,
					"```",
					samplePayload(sample.arguments, payloadChars, sample.argumentsBytes),
					"```",
					`Result:`,
					"```",
					samplePayload(sample.result, payloadChars, sample.resultBytes),
					"```",
				)
			}
			if (samples.nextCursor !== undefined) {
				lines.push(
					``,
					`More samples exist past this page — raise samples_limit, or narrow with session="…".`,
				)
			}

			const firstSession = detail.sessions[0]
			const firstSample = samples.occurrences[0]
			lines.push(
				formatNextSteps([
					...(firstSession === undefined
						? []
						: [
								`\`get_agent_session session_id="${firstSession.sessionId}"\` — the session that hit this group most`,
							]),
					...(firstSample === undefined
						? []
						: [
								`\`inspect_span trace_id="${firstSample.traceId}" span_id="${firstSample.spanId}" timestamp="${warehouseDateTimeToIso(
									firstSample.timestamp,
								)}"\` — the failed call in full`,
							]),
					`\`get_agent_tool_error tool="${tool}" fingerprint="${fingerprint.value}" session="<session>"\` — the same group inside one session`,
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_agent_tool_error",
					data: {
						timeRange: { start: st, end: et },
						selection: agentToolSelectionData(tool, params),
						fingerprint: fingerprint.value,
						sessions: detail.sessions.map((session) => ({ ...session })),
						variants: detail.variants.map((variant) => ({ ...variant })),
						breakdown: detail.breakdown.map((row) => ({ ...row })),
						samples: samples.occurrences.map((sample) => ({
							timestamp: sample.timestamp,
							traceId: sample.traceId,
							spanId: sample.spanId,
							sessionId: sample.sessionId,
							vendorId: sample.vendorId,
							agentName: sample.agentName,
							model: sample.model,
							service: sample.service,
							errorType: sample.errorType,
							message: sample.message,
							durationMs: sample.durationNs / 1_000_000,
							statusCode: sample.statusCode,
							arguments: sample.arguments.slice(0, payloadChars),
							argumentsBytes: sample.argumentsBytes,
							result: sample.result.slice(0, payloadChars),
							resultBytes: sample.resultBytes,
						})),
						hasMoreSamples: samples.nextCursor !== undefined,
					},
				}),
			}
		}),
	)
}
