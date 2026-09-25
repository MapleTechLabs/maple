import { Effect, Option, Schema } from "effect"
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
import { GetAgentToolErrorOutput } from "@maple/domain/mcp-outputs"
import {
	AI_TOOL_ERROR_PAYLOAD_MAX,
	AI_TOOL_ERROR_SESSIONS_LIMIT,
	AI_TOOL_ERROR_VARIANTS_LIMIT,
} from "@maple/query-engine-integrations/ai"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import {
	AGENT_TOOL_WINDOW,
	agentToolSelection,
	agentToolScopeParams,
	boundedText,
	cellOrDash,
	decodeFingerprint,
	describeSelection,
	formatNanos,
	formatSeen,
	orDash,
	pageCount,
	selectionArgs,
	selectionRequest,
} from "../lib/agent-tool-analytics"
import { paddedWindowArgs } from "../lib/agent-sessions"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatNumber, tableCell } from "../lib/format"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

const encoder = new TextEncoder()

/**
 * A payload as the caller asked to see it, with its true size beside it.
 *
 * Two cuts reach it (the SQL's {@link AI_TOOL_ERROR_PAYLOAD_MAX} and the caller's
 * `payload_chars`), so the ellipsis follows from the bytes the row reports against the bytes
 * rendered, which covers both. `retained` is whether the span behind the sample was read at all:
 * without it an argument that was genuinely empty reads as a payload nobody kept.
 */
const samplePayload = (text: string, bytes: number, retained: boolean): string => {
	if (text === "") return retained ? "(empty)" : "(not available: the span was not retained)"
	const cut = bytes > encoder.encode(text).length
	return `${text}${cut ? "…" : ""}\n(${formatNumber(bytes)} bytes total)`
}

export function registerGetAgentToolErrorTool(server: McpToolRegistrar) {
	server.define({
		name: "get_agent_tool_error",
		description:
			"One failure group of an AI agent tool call, as `get_agent_tools_overview tool=…` lists them with their `fingerprint`: the sessions that hit it, the message variants it folded, the models and services it fails under, and sample calls with their arguments and results.",
		parameters: Schema.Struct({
			...AGENT_TOOL_WINDOW.fields,
			tool: P.text(
				"The failing tool (exact `gen_ai.tool.name`, as `get_agent_tools_overview` lists it)",
			).check(Schema.isMaxLength(AI_TOOLS_SELECTION_MAX_CHARS)),
			fingerprint: P.text(
				"The error group, as `get_agent_tools_overview` reported it for this tool (a decimal number)",
			),
			...agentToolScopeParams,
			samples_session: boundedText(
				"Only samples from this session id. It narrows the Samples section alone: the sessions, variants and where-it-fails tables still cover the whole group",
				AI_TOOL_ERROR_SESSION_MAX_CHARS,
			),
			samples_limit: P.limit({ default: 10, max: 100, noun: "sample calls" }),
			payload_chars: P.limit({
				default: 800,
				max: AI_TOOL_ERROR_PAYLOAD_MAX,
				description: "Characters kept of each argument and result block",
			}),
		}),
		output: GetAgentToolErrorOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting an agent tool error"],
		handler: Effect.fn("McpTool.getAgentToolError")(function* (params) {
			const { st, et } = yield* AGENT_TOOL_WINDOW.resolve(params, "get_agent_tool_error")
			const fingerprint = decodeFingerprint(params.fingerprint)
			if (Option.isNone(fingerprint)) {
				return yield* new McpInvalidInputError({
					message: `Invalid fingerprint: '${params.fingerprint}'. It is the decimal number \`get_agent_tools_overview tool="<tool>"\` prints in its Fingerprint column.`,
					parameter: "fingerprint",
					example: `get_agent_tool_error tool="search_docs" fingerprint="10453282193948324021"`,
				})
			}
			const tool = params.tool.trim()
			if (tool === "") {
				return yield* new McpInvalidInputError({
					message:
						"Invalid tool: a tool name is required. It is an exact `gen_ai.tool.name`, as `get_agent_tools_overview` lists it in its breakdown.",
					parameter: "tool",
					example: `get_agent_tool_error tool="search_docs" fingerprint="${params.fingerprint}"`,
				})
			}
			const sessionFilter = params.samples_session
			const payloadChars = params.payload_chars
			const selection = agentToolSelection(params, tool)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				tool,
				fingerprint: fingerprint.value,
				limit: params.samples_limit,
			})

			const scope = {
				startTime: st,
				endTime: et,
				...selectionRequest(selection),
				tool,
				fingerprint: fingerprint.value,
			}
			const [detail, samples] = yield* Effect.all(
				[
					readAiToolErrorDetail(tenant, new AiToolErrorDetailRequest(scope)),
					readAiToolErrorSamples(
						tenant,
						new AiToolErrorSamplesRequest({
							...scope,
							limit: params.samples_limit,
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

			return {
				timeRange: { start: st, end: et },
				tool,
				fingerprint: fingerprint.value,
				selection,
				...(sessionFilter === undefined ? undefined : { samplesSession: sessionFilter }),
				payloadChars,
				sessions: detail.sessions,
				sessionsCap: AI_TOOL_ERROR_SESSIONS_LIMIT,
				variants: detail.variants,
				variantsCap: AI_TOOL_ERROR_VARIANTS_LIMIT,
				breakdown: detail.breakdown,
				// Clipped here, so the output carries what the answer shows; `*Bytes` keep the true size.
				samples: samples.occurrences.map((sample) => ({
					...sample,
					arguments: sample.arguments.slice(0, payloadChars),
					result: sample.result.slice(0, payloadChars),
				})),
				hasMoreSamples: samples.nextCursor !== undefined,
			}
		}),
		render: (output) => {
			const { tool, sessions, variants, breakdown, samples } = output
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const overview = doc.next(
				"get_agent_tools_overview",
				{ ...window, tool, ...selectionArgs(output.selection) },
				"the groups that exist in this window (a fingerprint is only visible while its failures are in range)",
			)
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Tool", tableCell(tool)],
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
			]
			const title = `Tool failure group ${output.fingerprint}`
			const selectionLine = doc.text(`Selection: ${describeSelection(output.selection)}`)

			if (sessions.length === 0 && samples.length === 0) {
				return {
					title,
					scope,
					empty: {
						message: `No failed calls of \`${tableCell(tool)}\` under this fingerprint in the window.`,
					},
					blocks: [selectionLine],
					next: [overview],
				}
			}

			const sampleBlocks: ReadonlyArray<DocBlock> = samples.flatMap((sample) => [
				doc.text(
					[
						`**${formatSeen(sample.timestamp)}** · session \`${tableCell(sample.sessionId)}\` · agent ${orDash(sample.agentName)} · model ${sample.model === "" ? "(unattributed)" : tableCell(sample.model)} · service ${orDash(sample.service)}`,
						`duration ${formatNanos(sample.durationNs)} · status ${orDash(sample.statusCode)} · error.type ${orDash(sample.errorType)}`,
						`trace \`${tableCell(sample.traceId)}\` span \`${tableCell(sample.spanId)}\``,
						`Message: ${orDash(sample.message, 400)}`,
						"Arguments:",
					].join("\n"),
				),
				doc.code("", samplePayload(sample.arguments, sample.argumentsBytes, sample.retained)),
				doc.text("Result:"),
				doc.code("", samplePayload(sample.result, sample.resultBytes, sample.retained)),
			])

			const firstSession = sessions[0]
			const firstSample = samples[0]
			return {
				title,
				scope,
				blocks: [
					selectionLine,
					...(sessions.length === 0
						? []
						: [
								doc.heading(
									`Sessions (${pageCount(sessions, output.sessionsCap)}, most hits first)`,
								),
								doc.table(
									["Session", "Vendor", "Agent", "Service", "Hits", "Last seen"],
									sessions.map((row) => [
										row.sessionId,
										cellOrDash(row.vendorId),
										cellOrDash(row.agentName, 40),
										cellOrDash(row.service),
										formatNumber(row.hits),
										formatSeen(row.lastSeen),
									]),
								),
								...(sessions.length < output.sessionsCap
									? []
									: [
											doc.text(
												`The read stops at ${output.sessionsCap} sessions, so more may have hit this group; its true count is the Sessions column of \`get_agent_tools_overview tool=${JSON.stringify(tool)}\`.`,
											),
										]),
							]),
					...(variants.length === 0
						? []
						: [
								doc.heading(
									`Message variants (${pageCount(variants, output.variantsCap)}, most calls first)`,
								),
								doc.table(
									["Calls", "Last seen", "Message"],
									variants.map((row) => [
										formatNumber(row.calls),
										formatSeen(row.lastSeen),
										cellOrDash(row.message, 200),
									]),
								),
								...(variants.length < output.variantsCap
									? []
									: [
											doc.text(
												`The read stops at ${output.variantsCap} variants, so the group may have folded more; its true count is the Variants column of \`get_agent_tools_overview tool=${JSON.stringify(tool)}\`.`,
											),
										]),
							]),
					...(breakdown.length === 0
						? []
						: [
								doc.heading("Where it fails"),
								doc.table(
									["Model", "Service", "Calls"],
									breakdown.map((row) => [
										row.model === "" ? "(unattributed)" : row.model,
										cellOrDash(row.service),
										formatNumber(row.calls),
									]),
								),
							]),
					doc.heading(
						`Samples (${samples.length}, newest first${
							output.samplesSession === undefined
								? ""
								: `, session ${tableCell(output.samplesSession)} only`
						})`,
					),
					...sampleBlocks,
					...(output.hasMoreSamples
						? [
								doc.text(
									'More samples exist past this page: raise samples_limit, or narrow with samples_session="…".',
								),
							]
						: []),
				],
				next: [
					// The bounds a session read seeks on, padded around the failure the way a list row's
					// are: the sibling tool asks for them, and this answer holds the only instant.
					...(firstSession === undefined
						? []
						: [
								doc.next(
									"get_agent_session",
									{
										session_id: firstSession.sessionId,
										...(firstSample === undefined
											? undefined
											: paddedWindowArgs({
													startTime: firstSample.timestamp,
													endTime: firstSample.timestamp,
												})),
									},
									"the session that hit this group most",
								),
							]),
					...(firstSample === undefined
						? []
						: [
								doc.next(
									"inspect_span",
									{
										trace_id: firstSample.traceId,
										span_id: firstSample.spanId,
										timestamp: warehouseDateTimeToIso(firstSample.timestamp),
									},
									"the failed call in full",
								),
							]),
				],
			}
		},
	})
}
