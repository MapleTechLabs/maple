// The agent transcript bench fixture (`buildLargeSessionFixture`),
// a session big enough to hurt: every call carries its prompt and reply, every tool a large result.

import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"
import { agentSpan, llmSpan, toolSpan, userMessages } from "@maple/agent-sessions/testing"

const SECOND = 1000
const TURN_GAP_MS = 90 * SECOND
const VENDOR_ID = "claude_agent_sdk"

/** Deterministic, so two runs of the bench render the same bytes. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const WORDS =
	"retry backoff webhook idempotency charge invoice customer ledger dispatch queue partition replica latency p95 deploy rollback config jitter attempt handler schema migration index cursor".split(
		" ",
	)

function prose(random: () => number, words: number): string {
	const out: string[] = []
	for (let i = 0; i < words; i++) {
		const word = WORDS[Math.floor(random() * WORDS.length)]!
		out.push(i > 0 && i % 17 === 0 ? `${word}.` : word)
	}
	return out.join(" ")
}

const SYSTEM_INSTRUCTIONS = [
	"You are a careful coding agent working in a payments monorepo.",
	"",
	"## Rules",
	"",
	...Array.from({ length: 160 }, (_, i) => `${i + 1}. Rule ${i + 1}: ${prose(mulberry32(i), 14)}`),
].join("\n")

function markdownReply(random: () => number, paragraphs: number): string {
	const blocks: string[] = []
	for (let p = 0; p < paragraphs; p++) {
		blocks.push(prose(random, 40 + Math.floor(random() * 50)))
		if (p % 3 === 1) {
			blocks.push(
				[
					"```ts",
					...Array.from(
						{ length: 12 },
						(_, i) => `const step${i} = retry(${i}, { jitter: ${random().toFixed(3)} })`,
					),
					"```",
				].join("\n"),
			)
		}
		if (p % 4 === 2) {
			blocks.push(
				Array.from({ length: 5 }, (_, i) => `- **item ${i}**: ${prose(random, 9)}`).join("\n"),
			)
		}
	}
	return blocks.join("\n\n")
}

/** A warehouse-shaped result: rows of one query, sized by `rows`. */
function jsonResult(random: () => number, rows: number): Record<string, unknown> {
	return {
		query_id: `q_${Math.floor(random() * 1e9).toString(16)}`,
		elapsed_ms: Math.round(random() * 4000),
		rows: Array.from({ length: rows }, (_, i) => ({
			t: new Date(Date.UTC(2026, 7, 25, 13, 50) + i * 60_000).toISOString(),
			service: `checkout-api-${i % 7}`,
			p95_ms: Number((80 + random() * 900).toFixed(2)),
			count: Math.floor(random() * 5000),
			error_rate: Number((random() * 0.05).toFixed(4)),
			region: random() > 0.5 ? "eu-central-1" : "us-east-1",
		})),
	}
}

function textResult(random: () => number, lines: number): string {
	return Array.from(
		{ length: lines },
		(_, i) => `${String(i + 1).padStart(4, " ")}  ${prose(random, 10)}`,
	).join("\n")
}

function usage(inputTokens: number, outputTokens: number): AiSessionGenAiValues {
	return {
		usageInputTokens: inputTokens,
		usageOutputTokens: outputTokens,
		usageCost: inputTokens * 0.000003 + outputTokens * 0.000015,
	}
}

/**
 * `turns` turns, each: one agent span, three model calls (the last one the
 * closing reply, the others each dispatching a tool), and two tool spans whose
 * results run from ten kilobytes to a few hundred.
 */
export function buildLargeSessionFixture(turns: number, seed = 1): readonly AiSessionSpan[] {
	const random = mulberry32(seed)
	const spans: AiSessionSpan[] = []
	const tools = ["run_sql", "read_file", "search_traces", "grep_repo"]

	for (let turn = 0; turn < turns; turn++) {
		const traceId = `trace-big-${turn}`
		const agentId = `big-${turn}-agent`
		const t = turn * TURN_GAP_MS
		spans.push(
			agentSpan({
				spanId: agentId,
				traceId,
				startMs: t,
				durationMs: 60 * SECOND,
				agentName: "coding-agent",
				vendorId: VENDOR_ID,
			}),
		)
		const prompt = `${prose(random, 30 + Math.floor(random() * 600))}\n\n\`\`\`\n${textResult(random, 8)}\n\`\`\``
		for (let call = 0; call < 3; call++) {
			const closing = call === 2
			const tool = closing ? undefined : tools[(turn + call) % tools.length]!
			const callId = `big-${turn}-${call}`
			spans.push(
				llmSpan({
					spanId: `big-${turn}-l${call}`,
					parentSpanId: agentId,
					traceId,
					startMs: t + call * 20 * SECOND,
					durationMs: 4 * SECOND,
					spanName: "chat claude-opus-5",
					model: "claude-opus-5",
					ttftSeconds: 0.6,
					vendorId: VENDOR_ID,
					genAi: {
						...usage(20_000 + turn * 3_000 + call * 4_000, 800 + call * 400),
						systemInstructions: SYSTEM_INSTRUCTIONS,
						inputMessages: call === 0 ? userMessages(prompt) : undefined,
						outputMessages: [
							{
								role: "assistant",
								parts: [
									...(call % 2 === 0
										? [
												{
													type: "reasoning",
													content: prose(random, 200 + Math.floor(random() * 200)),
												},
											]
										: []),
									{
										type: "text",
										content: markdownReply(
											random,
											closing ? 6 + Math.floor(random() * 6) : 1,
										),
									},
									...(tool === undefined
										? []
										: [
												{
													type: "tool_call",
													id: callId,
													name: tool,
													arguments: {
														sql: `SELECT * FROM traces WHERE turn = ${turn} AND call = ${call}`,
														filters: Array.from({ length: 12 }, (_, i) => ({
															key: `attr.${i}`,
															value: prose(random, 3),
														})),
													},
												},
											]),
								],
							},
						],
						responseFinishReasons: [closing ? "stop" : "tool_use"],
					},
				}),
			)
			if (tool !== undefined) {
				const textual = (turn * 3 + call) % 6 === 0
				spans.push(
					toolSpan({
						spanId: `big-${turn}-t${call}`,
						parentSpanId: agentId,
						traceId,
						startMs: t + call * 20 * SECOND + 5 * SECOND,
						durationMs: 2 * SECOND,
						serviceName: "warehouse-mcp",
						toolName: tool,
						vendorId: VENDOR_ID,
						genAi: {
							toolCallId: callId,
							toolCallArguments: {
								sql: `SELECT * FROM traces WHERE turn = ${turn} AND call = ${call}`,
								filters: Array.from({ length: 12 }, (_, i) => ({
									key: `attr.${i}`,
									value: prose(random, 3),
								})),
							},
							toolCallResult: textual
								? textResult(random, 300 + Math.floor(random() * 300))
								: jsonResult(random, 80 + Math.floor(random() * 1_200)),
						},
					}),
				)
			}
		}
	}
	return spans
}
