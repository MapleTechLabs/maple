/**
 * Blocks → a Slack body. The limits are the interesting part: Slack rejects a whole message over
 * one oversized field, so a turn that overruns one must still be a turn.
 */
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { decodeChatActionControlId, encodeChatActionToken, type ChatActionToken } from "../../action-token"
import type { ChatAlertBlock, ChatBlock } from "../../render/blocks"
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

const alert = (overrides: Partial<ChatAlertBlock> = {}): ChatAlertBlock => ({
	kind: "alert",
	color: "#e01e5a",
	title: "\u{1F6A8} High error rate — Triggered",
	summary: "**Error Rate** is **49.7%** — above the 5% threshold, measured over the last 5m.",
	fields: [
		{ label: "Severity", value: "\u{1F534} Critical" },
		{ label: "Group", value: "`electric-sync`" },
	],
	imageUrl: null,
	imageAlt: "High error rate over the alert window",
	links: [
		{ label: "Open in Maple", url: "https://app.maple.dev/alerts/1", primary: true },
		{ label: "✨ Ask Maple AI", url: "https://app.maple.dev/chat", primary: false },
	],
	footer: ["\u{1F341} Maple Alerts", "`▁▁▇`", "Incident `inc_1`"],
	sentAtMs: 1_700_000_000_000,
	...overrides,
})

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
		const block = payload.blocks?.[0]
		expect(block?.type === "section" && block.text.text.length).toBe(MAX_SECTION_CHARS)
	})

	it("keeps the first blocks when a turn runs past Slack's block limit", () => {
		const payload = renderSlackMessage(
			Array.from({ length: MAX_BLOCKS + 10 }, (_, index) => prose(`line ${index}`)),
		)
		expect(payload.blocks).toHaveLength(MAX_BLOCKS)
		const first = payload.blocks?.[0]
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
		expect(payload.blocks?.[1]).toEqual({
			type: "image",
			image_url: "https://app.maple.dev/chart.png",
			alt_text: "p99 latency over 24h, peaking at 2.1s",
		})
	})

	it("falls back to the summary when there is no image, so the numbers are not lost", () => {
		const payload = renderSlackMessage([chart(null)])
		expect(payload.blocks).toHaveLength(1)
		expect(payload.blocks?.[0]?.type).toBe("section")
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
		const block = payload.blocks?.[0]
		expect(block?.type === "section" && block.text.text).toBe(
			"p99 for &lt;!channel&gt; &amp; &lt;@U0123&gt;",
		)
	})

	it("drops an over-long image URL rather than sending a message Slack rejects", () => {
		const payload = renderSlackMessage([
			chart(`https://app.maple.dev/${"x".repeat(MAX_IMAGE_URL_CHARS)}`),
		])
		expect(payload.blocks?.some((block) => block.type === "image")).toBe(false)
	})
})

describe("approvals", () => {
	const approval = (value: string): ChatBlock => ({
		kind: "approval",
		toolName: "create_dashboard",
		summary: "Creates a dashboard called Checkout",
		token: token(value),
		outcome: null,
	})

	it("carries each button's decision and the action token as its value", () => {
		const payload = renderSlackMessage([approval("sess-1|call-1")])
		const actions = payload.blocks?.[1]
		expect(actions?.type === "actions" && actions.elements).toEqual([
			{
				type: "button",
				text: { type: "plain_text", text: "Run create_dashboard" },
				action_id: APPROVE_ACTION,
				value: "approve:sess-1|call-1",
				style: "primary",
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Skip" },
				action_id: DENY_ACTION,
				value: "deny:sess-1|call-1",
				style: "danger",
			},
		])
	})

	it("hands the host a value it reads back as each button's decision", () => {
		// The host decodes the clicked button's value alone; `action_id` never reaches it.
		const payload = renderSlackMessage([approval(encodeChatActionToken("call_1"))])
		const actions = payload.blocks?.[1]
		const values = actions?.type === "actions" ? actions.elements.map((button) => button.value) : []
		expect(values.map((value) => Option.getOrUndefined(decodeChatActionControlId(value ?? "")))).toEqual([
			{ decision: "approve", toolCallId: "call_1" },
			{ decision: "deny", toolCallId: "call_1" },
		])
	})

	it("keeps a settled proposal's line and loses its buttons", () => {
		// Slack leaves a button clickable forever, so a decided proposal must stop offering one —
		// the click would only ever be answered "settled".
		const payload = renderSlackMessage([
			{
				kind: "approval",
				toolName: "create_dashboard",
				summary: "Creates a dashboard called Checkout",
				token: token("call-1"),
				outcome: { approved: true, text: "Ada approved this." },
			},
		])
		expect(payload.blocks?.some((block) => block.type === "actions")).toBe(false)
		const block = payload.blocks?.[0]
		expect(block?.type === "section" && block.text.text).toContain("Ada approved this.")
	})

	it("says so rather than sending buttons Slack would reject the message over", () => {
		const payload = renderSlackMessage([approval("x".repeat(MAX_BUTTON_VALUE_CHARS + 1))])
		expect(payload.blocks?.some((block) => block.type === "actions")).toBe(false)
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
		const block = payload.blocks?.[0]
		expect(block?.type === "section" && block.text.text).toBe(
			"*Trace* <https://app.maple.dev/traces/abc|GET /checkout &amp; pay>\n2.1s",
		)
	})

	it("puts tool activity in a context block, not a card per call", () => {
		const payload = renderSlackMessage([
			{
				kind: "activity",
				tools: [
					{ label: "Searching traces", status: "done", detail: null },
					{ label: "Running a query", status: "running", detail: null },
				],
			},
		])
		expect(payload.blocks?.[0]).toEqual({
			type: "context",
			elements: [{ type: "mrkdwn", text: "Searching traces… · Running a query…" }],
		})
	})

	it("renders an error notice loudly and everything else quietly", () => {
		expect(renderSlackMessage([{ kind: "notice", tone: "error", text: "it broke" }]).blocks?.[0]).toEqual(
			{
				type: "section",
				text: { type: "mrkdwn", text: "*it broke*" },
			},
		)
		expect(
			renderSlackMessage([{ kind: "notice", tone: "info", text: "thinking" }]).blocks?.[0]?.type,
		).toBe("context")
	})

	it("renders an alert as the coloured card, with no top-level text to duplicate it", () => {
		const payload = renderSlackMessage([alert()])
		expect(payload.text).toBeUndefined()
		expect(payload.blocks).toBeUndefined()
		expect(payload.attachments).toHaveLength(1)
		const attachment = payload.attachments?.[0]
		expect(attachment?.color).toBe("#e01e5a")
		expect(attachment?.fallback).toContain("High error rate — Triggered")
		expect(attachment?.blocks).toEqual([
			{
				type: "header",
				text: { type: "plain_text", text: "\u{1F6A8} High error rate — Triggered", emoji: true },
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Error Rate* is *49.7%* — above the 5% threshold, measured over the last 5m.",
				},
				fields: [
					{ type: "mrkdwn", text: "*Severity*\n\u{1F534} Critical" },
					{ type: "mrkdwn", text: "*Group*\n`electric-sync`" },
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Open in Maple", emoji: true },
						action_id: "maple_link_0",
						url: "https://app.maple.dev/alerts/1",
						style: "primary",
					},
					{
						type: "button",
						text: { type: "plain_text", text: "✨ Ask Maple AI", emoji: true },
						action_id: "maple_link_1",
						url: "https://app.maple.dev/chat",
					},
				],
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "\u{1F341} Maple Alerts  ·  `▁▁▇`  ·  Incident `inc_1`  ·  <!date^1700000000^{date_short_pretty} at {time}|2023-11-14T22:13:20.000Z>",
					},
				],
			},
		])
	})

	it("puts an alert's chart between the summary and the buttons", () => {
		const blocks = renderSlackMessage([alert({ imageUrl: "https://charts.maple.dev/c.png" })])
			.attachments?.[0]?.blocks
		expect(blocks?.map((block) => block.type)).toEqual([
			"header",
			"section",
			"image",
			"actions",
			"context",
		])
	})

	it("keeps a mention in an alert's summary inert", () => {
		const section = renderSlackMessage([alert({ summary: "<!channel> look" })]).attachments?.[0]
			?.blocks[1]
		expect(section?.type === "section" && section.text.text).toBe("&lt;!channel&gt; look")
	})
})
