import { optionalNumberParam, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { clampLimit } from "@/mcp/lib/limits"
import { formatDurationFromMs } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import {
	clipPayload,
	SESSION_TOO_LARGE,
	sessionTooLargeResult,
	sessionWindowOf,
	sessionWindowParams,
	spanCategoryLabel,
} from "@/mcp/lib/agent-sessions"
import { Effect, Schema } from "effect"
import { GetAiSessionSpansRequest, type AiSessionSpan } from "@maple/domain/http"
import { sessionToolResults, spanMessages, spanToolCalls, type SpanMessage } from "@maple/agent-sessions"
import { readAiSessionSpans, resolveAiSessionWindow } from "@/services/ai-sessions/ai-session-reads"
import { warehouseReadToMcpHandlers } from "@/mcp/lib/map-warehouse-error"

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/

/** Spans of one trace — a turn's worth, which is what a trace-pinned read is. */
const TRACE_SPAN_LIMIT = 2_000

/** Input-history messages kept; a long conversation re-sends its whole history
 *  on every call, and the reader asked about THIS call. */
const INPUT_HISTORY_KEPT = 6

/**
 * The captured-content fields. They are rendered as messages and tool calls
 * below, so listing them again as raw attributes would print the whole
 * conversation twice.
 */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
	"systemInstructions",
	"inputMessages",
	"outputMessages",
	"toolCallArguments",
	"toolCallResult",
	"toolDefinitions",
	"retrievalDocuments",
	"memoryRecords",
])

const messageParts = (message: SpanMessage, payloadChars: number): string[] =>
	message.parts.map((part) => {
		switch (part.kind) {
			case "text":
				return clipPayload(part.text, payloadChars)
			case "tool_call":
				return `→ calls ${part.name ?? "?"}${part.id === undefined ? "" : ` (${part.id})`}: ${clipPayload(
					part.argumentsText ?? "",
					payloadChars,
				)}`
			case "tool_result":
				return `← result${part.id === undefined ? "" : ` (${part.id})`}: ${clipPayload(
					part.resultText,
					payloadChars,
				)}`
			case "reasoning":
				return part.redacted
					? `(reasoning redacted by the provider)`
					: `(reasoning) ${clipPayload(part.text ?? "", payloadChars)}`
		}
	})

const messageLines = (message: SpanMessage, payloadChars: number): string[] => {
	const head = `- **${message.origin}/${message.role}**`
	const parts = messageParts(message, payloadChars)
	return parts.length === 0 ? [`${head} (no content)`] : [head, ...parts.map((part) => `  ${part}`)]
}

export function registerInspectAgentSessionSpanTool(server: McpToolRegistrar) {
	server.tool(
		"inspect_agent_session_span",
		"Inspect one span of an AI agent session (an LLM agent trace, not a browser session replay): its timing and status, the decoded gen_ai attributes, the messages it captured (system instructions, input history, the output it produced) and the tool calls it made or executed, with each call's result resolved from the rest of the trace. Use after `get_agent_session` or `list_agent_session_spans`, which report the span and trace ids. For the raw attribute map use `inspect_span`.",
		Schema.Struct({
			session_id: requiredStringParam("The agent session id the span belongs to"),
			trace_id: requiredStringParam("The span's trace id (32 hex characters)"),
			span_id: requiredStringParam("The span id to inspect"),
			...sessionWindowParams,
			payload_chars: optionalNumberParam(
				"Characters of each message and payload to show (default 2000, max 20000)",
			),
		}),
		Effect.fn("McpTool.inspectAgentSessionSpan")(function* (params) {
			const windowInput = sessionWindowOf(params)
			if (windowInput._tag === "invalid") return windowInput.result
			if (!TRACE_ID_PATTERN.test(params.trace_id)) {
				return validationError(
					`Invalid trace_id: ${params.trace_id}. Expected 32 hex characters, as \`list_agent_session_spans\` reports it.`,
				)
			}
			const payloadChars = clampLimit(params.payload_chars, { defaultValue: 2_000, max: 20_000 })

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId: params.session_id,
				traceId: params.trace_id,
				spanId: params.span_id,
			})

			// A trace-pinned read is bounded by the window and nothing else, so an
			// absent one is resolved from the session id first.
			const window =
				windowInput.window ??
				(yield* resolveAiSessionWindow(tenant, params.session_id).pipe(
					Effect.catchTags(warehouseReadToMcpHandlers("inspect_agent_session_span")),
				)).window
			if (window === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No spans for AI agent session ${params.session_id}. Check the id with \`list_agent_sessions\`.`,
						},
					],
				}
			}

			const page = yield* readAiSessionSpans(
				tenant,
				new GetAiSessionSpansRequest({
					sessionId: params.session_id,
					startTime: window.startTime,
					endTime: window.endTime,
					traceIds: [params.trace_id],
					limit: TRACE_SPAN_LIMIT,
				}),
			).pipe(
				Effect.catchTag("@maple/http/ai-sessions/AiSessionTooLargeError", () =>
					Effect.succeed(SESSION_TOO_LARGE),
				),
				Effect.catchTags(warehouseReadToMcpHandlers("inspect_agent_session_span")),
			)
			if (page === SESSION_TOO_LARGE) return sessionTooLargeResult(params.session_id)

			const traceSpans: readonly AiSessionSpan[] = page.data
			const span = traceSpans.find((candidate) => candidate.spanId === params.span_id)
			if (span === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Span ${params.span_id} is not in trace ${params.trace_id} (${traceSpans.length} spans read). List the session's spans with \`list_agent_session_spans session_id="${params.session_id}"\`.`,
						},
					],
				}
			}

			const messages = spanMessages(span)
			const inputs = messages.filter((message) => message.origin === "input")
			const earlier = Math.max(0, inputs.length - INPUT_HISTORY_KEPT)
			const keptInputs = new Set(inputs.slice(earlier))
			const shown = messages.filter((message) => message.origin !== "input" || keptInputs.has(message))
			const toolCalls = spanToolCalls(span, sessionToolResults(traceSpans))
			const attributes = Object.entries(span.genAi)
				.filter(([field, value]) => !CONTENT_FIELDS.has(field) && value !== undefined)
				.map(
					([field, value]) =>
						[field, Array.isArray(value) ? value.join(", ") : String(value)] as const,
				)
				.sort(([a], [b]) => a.localeCompare(b))

			const lines: string[] = [
				`## ${span.spanName} (${spanCategoryLabel(span)}) — span ${span.spanId}`,
				`Session ${params.session_id} · trace ${span.traceId} · parent ${span.parentSpanId || "none"}`,
				`Service ${span.serviceName} · ${span.timestamp} · ${formatDurationFromMs(span.durationMs)} · status ${span.statusCode}${
					span.statusMessage === "" ? "" : ` (${span.statusMessage})`
				}`,
			]

			if (attributes.length > 0) {
				lines.push(
					``,
					`### gen_ai attributes (${attributes.length})`,
					...attributes.map(([field, value]) => `- \`${field}\`: ${clipPayload(value, 500)}`),
				)
			}

			lines.push(``, `### Messages (${messages.length})`)
			if (messages.length === 0) {
				lines.push(`This span captured no message content.`)
			} else {
				if (earlier > 0) lines.push(`(${earlier} earlier input messages omitted)`)
				for (const message of shown) lines.push(...messageLines(message, payloadChars))
			}

			if (toolCalls.length > 0) {
				lines.push(``, `### Tool calls (${toolCalls.length})`)
				for (const call of toolCalls) {
					lines.push(
						`- **${call.name ?? "?"}**${call.id === undefined ? "" : ` (${call.id})`} — ${
							call.own ? "executed by this span" : "requested by this span"
						}`,
						`  args: ${call.argumentsText === undefined ? "—" : clipPayload(call.argumentsText, payloadChars)}`,
						`  result: ${call.resultText === undefined ? "not captured" : clipPayload(call.resultText, payloadChars)}`,
					)
				}
			}

			lines.push(
				formatNextSteps([
					`\`inspect_span trace_id="${span.traceId}" span_id="${span.spanId}"\` — the raw attribute map, including non-AI attributes`,
					`\`inspect_trace trace_id="${span.traceId}"\` — the whole trace this span ran in`,
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "inspect_agent_session_span",
					data: {
						sessionId: params.session_id,
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId,
						name: span.spanName,
						category: spanCategoryLabel(span),
						serviceName: span.serviceName,
						timestamp: span.timestamp,
						durationMs: span.durationMs,
						statusCode: span.statusCode,
						statusMessage: span.statusMessage,
						attributes: Object.fromEntries(attributes),
						earlierInputMessages: earlier,
						messages: shown.map((message) => ({
							role: message.role,
							origin: message.origin,
							text: messageParts(message, payloadChars).join("\n"),
						})),
						toolCalls: toolCalls.map((call) => ({
							name: call.name ?? null,
							callId: call.id ?? null,
							own: call.own,
							arguments:
								call.argumentsText === undefined
									? null
									: clipPayload(call.argumentsText, payloadChars),
							result:
								call.resultText === undefined
									? null
									: clipPayload(call.resultText, payloadChars),
						})),
					},
				}),
			}
		}),
	)
}
