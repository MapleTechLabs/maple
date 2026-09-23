/**
 * Blocks → a Slack body. The limits are the interesting part: Slack rejects a whole message over
 * one oversized field, so a turn that overruns one must still be a turn.
 */
import { describe, expect, it } from "vitest"
import type { ChatActionToken } from "../../action-token"
import type { ChatBlock } from "../../render/blocks"
import {
	APPROVE_ACTION,
	DENY_ACTION,
	EMPTY_TEXT,
	MAX_BLOCKS,
	MAX_BUTTON_VALUE_CHARS,
	MAX_IMAGE_URL_CHARS,
	MAX_SECTION_CHARS,
	renderSlackMessage,
} from "./render"

const token = (value: string) => value as ChatActionToken

const prose = (markdown: string): ChatBlock => ({ kind: "prose", markdown })

describe("slack message bodies", () => {
	it("renders prose as a mrkdwn section and repeats it as the notification fallback", () => {
		const payload = renderSlackMessage([prose("**checkout** is slow")])
		expect(payload.blocks).toEqual([
			{ type: "section", text: { type: "mrkdwn", text: "*checkout* is slow" } },
		])
		// What a push notification and a screen reader read.
		expect(payload.text).toBe("**checkout** is slow")
		expect(payload.unfurl_links).toBe(false)
	})

	it("answers an empty turn with something Slack will accept", () => {
		// Slack rejects a post carrying neither text nor blocks, and the driver empties a message a
		// retraction shrank a turn past.
		const payload = renderSlackMessage([])
		expect(payload.text).toBe(EMPTY_TEXT)
		expect(payload.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: EMPTY_TEXT } }])
	})

	it("clamps a section rather than letting Slack refuse the message", () => {
		const payload = renderSlackMessage([prose("x".repeat(MAX_SECTION_CHARS * 2))])
		const block = payload.blocks[0]
		expect(block?.type === "section" && block.text.text.length).toBe(MAX_SECTION_CHARS)
	})

	it("keeps the first blocks when a turn runs past Slack's block limit", () => {
		const payload = renderSlackMessage(
			Array.from({ length: MAX_BLOCKS + 10 }, (_, index) => prose(`line ${index}`)),
		)
		expect(payload.blocks).toHaveLength(MAX_BLOCKS)
		const first = payload.blocks[0]
		expect(first?.type === "section" && first.text.text).toBe("line 0")
	})
})

describe("charts", () => {
	const chart = (imageUrl: string | null): ChatBlock => ({
		kind: "chart",
		spec: { type: "line" } as never,
		unit: "ms",
		title: "p99",
		summary: "p99 latency over 24h, peaking at 2.1s",
		imageUrl,
	})

	it("shows a picture with the required alt text beside its summary", () => {
		const payload = renderSlackMessage([chart("https://app.maple.dev/chart.png")])
		expect(payload.blocks[1]).toEqual({
			type: "image",
			image_url: "https://app.maple.dev/chart.png",
			alt_text: "p99 latency over 24h, peaking at 2.1s",
		})
	})

	it("falls back to the summary when there is no image, so the numbers are not lost", () => {
		const payload = renderSlackMessage([chart(null)])
		expect(payload.blocks).toHaveLength(1)
		expect(payload.blocks[0]?.type).toBe("section")
	})

	it("escapes a titleless chart's summary, which is model-authored like any other", () => {
		const payload = renderSlackMessage([
			{
				kind: "chart",
				spec: { type: "line" } as never,
				unit: "ms",
				title: null,
				summary: "p99 for <!channel> & <@U0123>",
				imageUrl: null,
			},
		])
		const block = payload.blocks[0]
		expect(block?.type === "section" && block.text.text).toBe(
			"p99 for &lt;!channel&gt; &amp; &lt;@U0123&gt;",
		)
	})

	it("drops an over-long image URL rather than sending a message Slack rejects", () => {
		const payload = renderSlackMessage([
			chart(`https://app.maple.dev/${"x".repeat(MAX_IMAGE_URL_CHARS)}`),
		])
		expect(payload.blocks.some((block) => block.type === "image")).toBe(false)
	})
})

describe("approvals", () => {
	const approval = (value: string): ChatBlock => ({
		kind: "approval",
		toolName: "create_dashboard",
		summary: "Creates a dashboard called Checkout",
		token: token(value),
	})

	it("carries the action token on both buttons, unchanged", () => {
		const payload = renderSlackMessage([approval("sess-1|call-1")])
		const actions = payload.blocks[1]
		expect(actions?.type === "actions" && actions.elements).toEqual([
			{
				type: "button",
				text: { type: "plain_text", text: "Run create_dashboard" },
				action_id: APPROVE_ACTION,
				value: "sess-1|call-1",
				style: "primary",
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Skip" },
				action_id: DENY_ACTION,
				value: "sess-1|call-1",
				style: "danger",
			},
		])
	})

	it("says so rather than sending buttons Slack would reject the message over", () => {
		const payload = renderSlackMessage([approval("x".repeat(MAX_BUTTON_VALUE_CHARS + 1))])
		expect(payload.blocks.some((block) => block.type === "actions")).toBe(false)
		expect(payload.text).toContain("Approve create_dashboard?")
	})
})

describe("the rest of the vocabulary", () => {
	it("links an entity and escapes its label", () => {
		const payload = renderSlackMessage([
			{
				kind: "entity",
				entity: "trace",
				label: "GET /checkout & pay",
				detail: "2.1s",
				url: "https://app.maple.dev/traces/abc",
			},
		])
		const block = payload.blocks[0]
		expect(block?.type === "section" && block.text.text).toBe(
			"*Trace* <https://app.maple.dev/traces/abc|GET /checkout &amp; pay>\n2.1s",
		)
	})

	it("puts tool activity in a context block, not a card per call", () => {
		const payload = renderSlackMessage([
			{
				kind: "activity",
				tools: [
					{ name: "search_traces", status: "done", detail: null },
					{ name: "run_sql", status: "running", detail: null },
				],
			},
		])
		expect(payload.blocks[0]).toEqual({
			type: "context",
			elements: [{ type: "mrkdwn", text: "Tools: `search_traces` · `run_sql`…" }],
		})
	})

	it("renders an error notice loudly and everything else quietly", () => {
		expect(renderSlackMessage([{ kind: "notice", tone: "error", text: "it broke" }]).blocks[0]).toEqual({
			type: "section",
			text: { type: "mrkdwn", text: "*it broke*" },
		})
		expect(renderSlackMessage([{ kind: "notice", tone: "info", text: "thinking" }]).blocks[0]?.type).toBe(
			"context",
		)
	})
})
