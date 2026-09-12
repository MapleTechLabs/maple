// The decoded view of one AI agent span: what it was, the gen_ai scalars it
// carries, the messages it captured and the tool calls it made or executed.
//
// `inspect_span` prints this above the raw attribute maps when the span it
// looked up carries AI signal, so an agent reaches an LLM call's conversation
// with the span id it already has — no second tool, and no second vocabulary.

import { AI_CORE_FIELDS, AI_PROMPT_VARIABLE_PREFIX } from "@maple/domain/gen-ai"
import type { InspectSpanAiData } from "@maple/domain"
import type { AiSessionSpan } from "@maple/domain/http"
import { aiFieldSourceKeys, aiSpanAttributeKeys } from "@maple/query-engine-integrations/ai"
import { sessionToolResults, spanMessages, spanToolCalls } from "@maple/agent-sessions"
import { clipPayload, spanCategoryLabel } from "@/mcp/lib/agent-sessions"
import type { SpanMessage } from "@maple/agent-sessions"

/** Input-history messages kept; a long conversation re-sends its whole history
 *  on every call, and the reader asked about THIS call. */
const INPUT_HISTORY_KEPT = 6

/**
 * The captured-content fields. They are rendered as messages and tool calls
 * below, so listing them again as scalars would print the whole conversation
 * twice.
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

/**
 * The attribute keys that mark a span as an AI span, as the span mapper reads
 * them: the union over every integration (the vendor stamp that would pick one
 * integration is itself one of the keys being looked for), minus the plain
 * semconv keys `AI_CORE_FIELDS` names — every ordinary HTTP client span carries
 * `error.type` and `server.address`, and neither is evidence of an LLM call.
 */
const AI_SIGNAL_KEYS: ReadonlySet<string> = (() => {
	const core = new Set([...AI_CORE_FIELDS].flatMap((field) => aiFieldSourceKeys(field)))
	return new Set(aiSpanAttributeKeys.filter((key) => !core.has(key)))
})()

/** Whether a raw span attribute map is worth decoding as an AI span. */
export function hasAiSignal(attributes: Record<string, string>): boolean {
	return Object.keys(attributes).some(
		(key) => AI_SIGNAL_KEYS.has(key) || key.startsWith(AI_PROMPT_VARIABLE_PREFIX),
	)
}

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

/**
 * The decoded sections and the structured block behind them.
 *
 * `traceSpans` is the rest of the span's trace: a model span's output only ever
 * MAKES its tool calls, and what each returned is captured on the tool span
 * that ran it, which `sessionToolResults` indexes by call id.
 */
export function renderAiSpan(
	span: AiSessionSpan,
	traceSpans: readonly AiSessionSpan[],
	payloadChars: number,
): { readonly lines: string[]; readonly data: InspectSpanAiData } {
	const category = spanCategoryLabel(span)
	const messages = spanMessages(span)
	const inputs = messages.filter((message) => message.origin === "input")
	const earlier = Math.max(0, inputs.length - INPUT_HISTORY_KEPT)
	const keptInputs = new Set(inputs.slice(earlier))
	const shown = messages.filter((message) => message.origin !== "input" || keptInputs.has(message))
	const toolCalls = spanToolCalls(span, sessionToolResults(traceSpans))
	const fields = Object.entries(span.genAi)
		.filter(([field, value]) => !CONTENT_FIELDS.has(field) && value !== undefined)
		.map(([field, value]) => [field, Array.isArray(value) ? value.join(", ") : String(value)] as const)
		.sort(([a], [b]) => a.localeCompare(b))

	const lines: string[] = [
		``,
		`### AI agent span — ${category}`,
		`Vendor ${span.vendorId ?? "—"} · session ${span.sessionId ?? `trace:${span.traceId}`} · ${
			span.spanName
		}`,
	]

	if (fields.length > 0) {
		lines.push(
			``,
			`#### gen_ai fields (${fields.length})`,
			...fields.map(([field, value]) => `- \`${field}\`: ${clipPayload(value, 500)}`),
		)
	}

	lines.push(``, `#### Messages (${messages.length})`)
	if (messages.length === 0) {
		lines.push(`This span captured no message content.`)
	} else {
		if (earlier > 0) lines.push(`(${earlier} earlier input messages omitted)`)
		for (const message of shown) lines.push(...messageLines(message, payloadChars))
	}

	if (toolCalls.length > 0) {
		lines.push(``, `#### Tool calls (${toolCalls.length})`)
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

	return {
		lines,
		data: {
			category,
			vendorId: span.vendorId ?? null,
			sessionId: span.sessionId ?? null,
			fields: Object.fromEntries(fields),
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
					call.argumentsText === undefined ? null : clipPayload(call.argumentsText, payloadChars),
				result: call.resultText === undefined ? null : clipPayload(call.resultText, payloadChars),
			})),
		},
	}
}
