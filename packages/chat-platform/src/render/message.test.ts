import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	makeChatSessionId,
	type ChatEventInput,
	type ChatMessage,
} from "@maple/domain/chat-session"
import { chartFences, parseChartSpec } from "@maple/domain/chat-chart-spec"
import { makeChatTranscript } from "@maple/domain/chat-transcript"
import { assert, describe, expect, it } from "vitest"
import type { ChatRenderContext } from "./blocks"
import { renderChatMessage, summarizeToolInput } from "./message"

const sessionId = makeChatSessionId("org_1", "bot-42")

const context: ChatRenderContext = {
	appBaseUrl: "https://app.maple.dev",
	sessionId,
	chartImageUrl: () => null,
}

/** The turn's assistant message, folded by the same code a live driver folds with. */
const turn = (inputs: ReadonlyArray<ChatEventInput>): ChatMessage => {
	const transcript = makeChatTranscript()
	inputs.forEach((input, index) =>
		transcript.add(decodeChatEventPayload(encodeChatEventPayload(input), index + 1), 0),
	)
	const message = transcript.messages.find((candidate) => candidate.role === "assistant")
	assert(message !== undefined)
	return message
}

const text = (body: string) =>
	turn([
		{ type: "turn-start", messageId: "a1" },
		{ type: "text-delta", messageId: "a1", text: body },
	])

const CHART =
	'{"type":"line","title":"p95","unit":"ms","data":[{"bucket":"2026-09-01T00:00:00Z","series":{"checkout":12}}]}'

describe("renderChatMessage", () => {
	it("lifts a chart fence out of the prose and keeps the order it was written in", () => {
		const blocks = renderChatMessage(text(`Before.\n\n\`\`\`chart\n${CHART}\n\`\`\`\n\nAfter.`), {
			...context,
			chartImageUrl: (ref) => `https://img.maple.dev/${ref.messageId}/${ref.chartIndex}.png`,
		})

		expect(blocks.map((block) => block.kind)).toEqual(["prose", "chart", "prose"])
		expect(blocks[0]).toMatchObject({ markdown: "Before." })
		expect(blocks[1]).toMatchObject({
			kind: "chart",
			title: "p95",
			unit: "duration_ms",
			summary: "checkout across 1 point",
			imageUrl: "https://img.maple.dev/a1/0.png",
		})
		expect(blocks[2]).toMatchObject({ markdown: "After." })
	})

	it("holds back a chart whose fence has not closed yet", () => {
		// Mid-stream: the JSON is half written. Showing it would put raw payload in a channel, and
		// the next edit re-renders the whole turn anyway.
		const blocks = renderChatMessage(text('Before.\n\n```chart\n{"type":"line"'), context)
		expect(blocks).toEqual([{ kind: "prose", markdown: "Before." }])
	})

	it("leaves a fence that is not a chart visible as the code it was", () => {
		const blocks = renderChatMessage(text('```chart\n{"type":"nonsense"}\n```'), context)
		expect(blocks).toEqual([{ kind: "prose", markdown: '```chart\n{"type":"nonsense"}\n```' }])
	})

	it("turns an entity annotation into a block with a deep link into the app", () => {
		const annotation = JSON.stringify({ name: "checkout", errorRate: 4.2, p95Ms: 1200 })
		const blocks = renderChatMessage(text(`Worst offender:\n<<maple:service:${annotation}>>`), context)

		expect(blocks[1]).toEqual({
			kind: "entity",
			entity: "service",
			label: "checkout",
			detail: "4.2% errors · p95 1.20s",
			url: "https://app.maple.dev/services/checkout",
		})
	})

	it("gives an error type no link, because the app has no page for one", () => {
		const annotation = JSON.stringify({ errorType: "DbTimeoutError", count: 42 })
		const blocks = renderChatMessage(text(`<<maple:error:${annotation}>>`), context)

		expect(blocks[0]).toEqual({
			kind: "entity",
			entity: "error",
			label: "DbTimeoutError",
			detail: "42 events",
			url: null,
		})
	})

	it("reports a running turn as the latest tool call alone", () => {
		const working = turn([
			{ type: "turn-start", messageId: "a1" },
			{ type: "tool-call", messageId: "a1", callId: "c1", name: "find_errors", input: {} },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
			{ type: "tool-call", messageId: "a1", callId: "c2", name: "search_traces", input: {} },
		])

		expect(renderChatMessage(working, context, true)).toEqual([
			{ kind: "activity", tools: [{ name: "search_traces", status: "running", detail: null }] },
		])
		// Finished, the reader has the answer in front of them and no use for the route to it.
		expect(renderChatMessage(working, context)).toEqual([])
	})

	it("names a sub-agent by the agent it delegates to on the same status line", () => {
		const blocks = renderChatMessage(
			turn([
				{ type: "turn-start", messageId: "a1" },
				{ type: "tool-call", messageId: "a1", callId: "t1", name: "task_reviewer", input: {} },
				{
					type: "turn-start",
					messageId: "s1",
					task: { id: "t1", agent: "reviewer", parentMessageId: "a1" },
				},
			]),
			context,
			true,
		)

		expect(blocks).toEqual([
			{ kind: "activity", tools: [{ name: "reviewer", status: "running", detail: "1 step" }] },
		])
	})

	it("keeps the answer and drops the narration the model wrote between its calls", () => {
		const investigating = turn([
			{ type: "turn-start", messageId: "a1" },
			{ type: "text-delta", messageId: "a1", text: "Let me look at the errors first." },
			{ type: "tool-call", messageId: "a1", callId: "c1", name: "find_errors", input: {} },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
			{ type: "text-delta", messageId: "a1", text: "Now I'll check the traces." },
			{ type: "tool-call", messageId: "a1", callId: "c2", name: "search_traces", input: {} },
			{ type: "tool-result", messageId: "a1", callId: "c2", output: null },
			{ type: "text-delta", messageId: "a1", text: "checkout is timing out on the database." },
		])

		expect(renderChatMessage(investigating, context)).toEqual([
			{ kind: "prose", markdown: "checkout is timing out on the database." },
		])
		// Mid-turn the same segment is shown, because it may be the answer — under the status line,
		// which is what it is an answer to.
		expect(renderChatMessage(investigating, context, true)).toEqual([
			{ kind: "activity", tools: [{ name: "search_traces", status: "done", detail: null }] },
			{ kind: "prose", markdown: "checkout is timing out on the database." },
		])
	})

	it("keeps the prose that explains a proposal, which nothing ran to supersede", () => {
		const proposing = turn([
			{ type: "turn-start", messageId: "a1" },
			{ type: "text-delta", messageId: "a1", text: "Checking." },
			{ type: "tool-call", messageId: "a1", callId: "c1", name: "find_errors", input: {} },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
			{ type: "text-delta", messageId: "a1", text: "I'll alert on the checkout p95." },
			{
				type: "tool-call",
				messageId: "a1",
				callId: "call_9",
				name: "create_alert_rule",
				input: { name: "checkout p95" },
				proposed: true,
			},
		])

		const blocks = renderChatMessage(proposing, context)
		// The words that explain what is being approved, not the ones before the search.
		expect(blocks[0]).toEqual({ kind: "prose", markdown: "I'll alert on the checkout p95." })
		expect(blocks[1]).toMatchObject({ kind: "approval", toolName: "create_alert_rule" })
		// The same words while the turn is still open, so settling does not move them.
		expect(renderChatMessage(proposing, context, true)).toContainEqual(blocks[0])
	})

	it("falls back to the last thing a turn said when it stopped without answering", () => {
		const blocks = renderChatMessage(
			turn([
				{ type: "turn-start", messageId: "a1" },
				{ type: "text-delta", messageId: "a1", text: "Checking the errors." },
				{ type: "tool-call", messageId: "a1", callId: "c1", name: "find_errors", input: {} },
				{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
			]),
			context,
		)

		// Better than a bare failure notice: it says how far the turn got.
		expect(blocks).toEqual([{ kind: "prose", markdown: "Checking the errors." }])
	})

	it("puts a call recorded before offsets existed at the end of the text, as web does", () => {
		// `textOffset` is optional on the wire, and a conversation older than it renders
		// prose-then-calls everywhere else. Defaulting it to 0 here would have declared the
		// narration before a real call to be the answer.
		const mixed: ChatMessage = {
			id: "a1",
			role: "assistant",
			text: "Narration first. The answer.",
			toolCalls: [
				{ id: "c1", name: "find_errors", input: {}, output: null, textOffset: 16 },
				{ id: "c2", name: "search_traces", input: {}, output: null },
			],
			createdAt: 0,
			startSeq: 1,
		}

		expect(renderChatMessage(mixed, context)).toEqual([{ kind: "prose", markdown: "The answer." }])
	})

	it("puts a blank line where a call interrupted the model, never running two segments together", () => {
		// Offsets are not sorted, so a stale one can sit before a later call's and leave a boundary
		// inside what is shown. Model text carries no separator of its own.
		const interrupted: ChatMessage = {
			id: "a1",
			role: "assistant",
			text: "Errors are up on checkout.The pool is saturated.",
			toolCalls: [
				{ id: "c1", name: "find_errors", input: {}, output: null, textOffset: 26 },
				{ id: "c2", name: "search_traces", input: {}, output: null, textOffset: 0 },
			],
			createdAt: 0,
			startSeq: 1,
		}

		expect(renderChatMessage(interrupted, context)).toEqual([
			{ kind: "prose", markdown: "Errors are up on checkout.\n\nThe pool is saturated." },
		])
	})

	it("does not cut the answer at an offset a retry left behind", () => {
		const retried = turn([
			{ type: "turn-start", messageId: "a1" },
			{ type: "text-delta", messageId: "a1", text: "Checking the errors." },
			{ type: "tool-call", messageId: "a1", callId: "c1", name: "find_errors", input: {} },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
			{ type: "text-delta", messageId: "a1", text: " Half an ans" },
			// The attempt is taken back past where c1 was recorded, and the retry answers afresh.
			{
				type: "turn-retry",
				messageId: "a1",
				attempt: 2,
				retractChars: 32,
				reason: "overloaded",
				delayMs: 0,
			},
			{ type: "text-delta", messageId: "a1", text: "checkout is down." },
		])

		// c1's offset is past the end of what the turn now says, so it cuts nothing.
		expect(renderChatMessage(retried, context)).toEqual([
			{ kind: "prose", markdown: "checkout is down." },
		])
	})

	it("numbers a chart by its place in the whole turn, not in the answer left of it", () => {
		const blocks = renderChatMessage(
			turn([
				{ type: "turn-start", messageId: "a1" },
				{ type: "text-delta", messageId: "a1", text: `First look:\n\`\`\`chart\n${CHART}\n\`\`\`` },
				{ type: "tool-call", messageId: "a1", callId: "c1", name: "query_data", input: {} },
				{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
				{
					type: "text-delta",
					messageId: "a1",
					text: `\nAnd after the deploy:\n\`\`\`chart\n${CHART}\n\`\`\``,
				},
			]),
			{ ...context, chartImageUrl: (ref) => `${ref.chartIndex}` },
		)

		// Whatever renders the image counts both fences, so the surviving one is still the second.
		expect(blocks[1]).toMatchObject({ kind: "chart", imageUrl: "1" })
	})

	it("renders a proposed call as an approval carrying the session and the call", () => {
		const blocks = renderChatMessage(
			turn([
				{ type: "turn-start", messageId: "a1" },
				{
					type: "tool-call",
					messageId: "a1",
					callId: "call_9",
					name: "create_alert_rule",
					input: { name: "checkout p95", threshold: 1200 },
					proposed: true,
				},
			]),
			context,
		)

		expect(blocks).toEqual([
			{
				kind: "approval",
				toolName: "create_alert_rule",
				summary: "name: checkout p95 · threshold: 1200",
				token: "org_1:bot-42|call_9",
			},
		])
	})
})

describe("summarizeToolInput", () => {
	it("stops after the arguments a reader can still take in", () => {
		const input = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, index]))
		expect(summarizeToolInput(input).split(" · ")).toHaveLength(7)
	})

	it("skips arguments that were not given", () => {
		expect(summarizeToolInput({ service: "checkout", env: null })).toBe("service: checkout")
	})
})

/**
 * The index a relayed chart's URL carries has to be the index the image
 * endpoint resolves it by, or a reader gets the wrong plot under the right
 * words. The two used to count differently.
 */
describe("chart index, against the endpoint that resolves it", () => {
	const imageUrls = (body: string): ReadonlyArray<string> =>
		renderChatMessage(text(body), {
			...context,
			chartImageUrl: (ref) => `${ref.chartIndex}`,
		}).flatMap((block) => (block.kind === "chart" && block.imageUrl !== null ? [block.imageUrl] : []))

	it("agrees with chartFences across a malformed fence and a fence that is not a chart", () => {
		const body = [
			"Latency climbed.",
			"```chart",
			"{ not json",
			"```",
			"Here is the query:",
			"```sql",
			"SELECT 1",
			"```",
			"And the shape of it:",
			"```chart",
			CHART,
			"```",
		].join("\n")

		// Two chart fences; the first does not parse, so only the second renders —
		// and it must still be numbered 1, the position `chartFences` gives it.
		expect(chartFences(body)).toHaveLength(2)
		expect(imageUrls(body)).toEqual(["1"])
		expect(parseChartSpec(chartFences(body)[1] ?? "")).not.toBeNull()
	})

	it("agrees when every fence is a chart", () => {
		const body = ["```chart", CHART, "```", "text", "```chart", CHART, "```"].join("\n")

		expect(imageUrls(body)).toEqual(["0", "1"])
		expect(chartFences(body)).toHaveLength(2)
	})

	it("keeps a non-chart fence in the prose rather than eating it", () => {
		const blocks = renderChatMessage(text("```sql\nSELECT 1\n```"), context)

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({ kind: "prose", markdown: "```sql\nSELECT 1\n```" })
	})
})
