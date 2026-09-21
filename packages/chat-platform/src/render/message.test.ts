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

	it("reports the tools of a turn as one status line, settled by the presence of an output", () => {
		const blocks = renderChatMessage(
			turn([
				{ type: "turn-start", messageId: "a1" },
				{ type: "tool-call", messageId: "a1", callId: "c1", name: "find_errors", input: {} },
				{ type: "tool-result", messageId: "a1", callId: "c1", output: null },
				{ type: "tool-call", messageId: "a1", callId: "c2", name: "search_traces", input: {} },
			]),
			context,
		)

		expect(blocks).toEqual([
			{
				kind: "activity",
				tools: [
					{ name: "find_errors", status: "done", detail: null },
					{ name: "search_traces", status: "running", detail: null },
				],
			},
		])
	})

	it("names a sub-agent by the agent it delegates to, and counts its steps", () => {
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
		)

		expect(blocks).toEqual([
			{ kind: "activity", tools: [{ name: "reviewer", status: "running", detail: "1 step" }] },
		])
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
