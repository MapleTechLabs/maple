// Span builders for the colocated tests in this directory.
//
// The real shape has a dozen required fields and a sixty-five-key `genAi` bag,
// so a test that spelled one out per span would be unreadable and would say
// nothing about the rule under test. Everything here defaults to "an ordinary
// AI span"; each test overrides only the attribute its rule reads.

import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"
import { formatWarehouseDateTimeMs } from "@maple/query-engine"

/** Session start, fixed so offsets in the tests read as seconds into the session. */
export const T0 = Date.UTC(2026, 7, 19, 10, 0, 0)

const at = (offsetMs: number): string => formatWarehouseDateTimeMs(T0 + offsetMs)

interface SpanInput {
	readonly spanId: string
	readonly parentSpanId?: string
	readonly traceId?: string
	/** Milliseconds after `T0`. */
	readonly startMs: number
	readonly durationMs: number
	readonly spanName?: string
	readonly spanKind?: string
	readonly serviceName?: string
	readonly statusCode?: string
	readonly statusMessage?: string
	readonly isAiSpan?: boolean
	readonly vendorId?: string
	readonly sessionId?: string
	readonly genAi?: AiSessionGenAiValues
}

export function makeSpan(input: SpanInput): AiSessionSpan {
	return {
		traceId: input.traceId ?? "trace-1",
		spanId: input.spanId,
		parentSpanId: input.parentSpanId ?? "",
		spanName: input.spanName ?? "gen_ai.chat",
		spanKind: input.spanKind ?? "Internal",
		serviceName: input.serviceName ?? "agent-runner",
		timestamp: at(input.startMs),
		durationMs: input.durationMs,
		statusCode: input.statusCode ?? "Unset",
		statusMessage: input.statusMessage ?? "",
		// The server derives this rather than accepting it, so the default follows
		// the same evidence: a vendor stamp or decoded gen_ai attributes.
		isAiSpan: input.isAiSpan ?? (input.vendorId !== undefined || input.genAi !== undefined),
		vendorId: input.vendorId,
		sessionId: input.sessionId,
		genAi: input.genAi ?? {},
	}
}

/** A model call. Usage goes in `genAi` under its `gen_ai.usage.*` names. */
export function llmSpan({
	model,
	ttftSeconds,
	...input
}: SpanInput & {
	readonly model?: string
	readonly ttftSeconds?: number
}): AiSessionSpan {
	return makeSpan({
		...input,
		spanName: input.spanName ?? "chat",
		genAi: {
			operationName: "chat",
			responseModel: model,
			responseTimeToFirstChunk: ttftSeconds,
			...input.genAi,
		},
	})
}

export function toolSpan({ toolName, ...input }: SpanInput & { readonly toolName?: string }): AiSessionSpan {
	return makeSpan({
		...input,
		spanName: input.spanName ?? "execute_tool",
		genAi: { operationName: "execute_tool", toolName: toolName ?? "read_file", ...input.genAi },
	})
}

export function agentSpan({
	agentName,
	...input
}: SpanInput & { readonly agentName?: string }): AiSessionSpan {
	return makeSpan({
		...input,
		spanName: input.spanName ?? "invoke_agent",
		genAi: {
			operationName: "invoke_agent",
			agentName: agentName ?? "billing-agent",
			...input.genAi,
		},
	})
}

interface OtelTextPart {
	readonly type: "text"
	readonly content: string
}

interface OtelMessage {
	readonly role: string
	readonly parts: readonly OtelTextPart[]
}

/** An OTel `gen_ai.input.messages` value: a system message and the user turns. */
export function userMessages(...texts: readonly string[]): readonly OtelMessage[] {
	return [
		{ role: "system", parts: [{ type: "text", content: "you are a helpful agent" }] },
		...texts.map((text): OtelMessage => ({ role: "user", parts: [{ type: "text", content: text }] })),
	]
}

/**
 * A LangGraph ReAct thread through the OpenInference LangChain instrumentor,
 * one trace per invoke, each invoke passing the whole conversation so far (as
 * captured from blind-py-langchain). The agent root records only the first
 * message of its input — nothing on turn 1, the thread's opening prompt on every
 * later turn — while each `ChatOpenAI` call carries the full history ending on
 * the turn's prompt.
 */
export function langGraphThreadSpans(prompts: readonly string[]): readonly AiSessionSpan[] {
	const user = (content: string): OtelMessage => ({ role: "user", parts: [{ type: "text", content }] })
	const reply = (turn: number): OtelMessage => ({
		role: "assistant",
		parts: [{ type: "text", content: `answer ${turn + 1}` }],
	})
	return prompts.flatMap((prompt, turn) => {
		const traceId = `trace-${turn + 1}`
		const startMs = turn * 10_000
		const history = prompts.slice(0, turn).flatMap((earlier, i) => [user(earlier), reply(i)])
		return [
			agentSpan({
				spanId: `agent-${turn + 1}`,
				traceId,
				spanName: "ReAct Agent",
				startMs,
				durationMs: 3_000,
				vendorId: "langchain",
				agentName: "ReAct Agent",
				genAi: turn === 0 ? {} : { inputMessages: [user(prompts[0]!)] },
			}),
			makeSpan({
				spanId: `call-model-${turn + 1}`,
				parentSpanId: `agent-${turn + 1}`,
				traceId,
				spanName: "call_model",
				startMs: startMs + 1,
				durationMs: 2_000,
				vendorId: "langchain",
				genAi: { operationName: "invoke_workflow" },
			}),
			llmSpan({
				spanId: `chat-${turn + 1}`,
				parentSpanId: `call-model-${turn + 1}`,
				traceId,
				spanName: "ChatOpenAI",
				startMs: startMs + 200,
				durationMs: 1_500,
				vendorId: "langchain",
				model: "openai/gpt-5-mini",
				genAi: {
					inputMessages: [...userMessages(), ...history, user(prompt)],
					outputMessages: [reply(turn)],
				},
			}),
		]
	})
}
