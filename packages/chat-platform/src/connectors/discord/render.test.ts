import { describe, expect, it } from "vitest"
import type { ChatBlock } from "../../render/blocks"
import type { ChatActionToken } from "../../action-token"
import { EMPTY_CONTENT, MAX_ACTION_ROWS, MAX_CONTENT_CHARS, renderDiscordMessage } from "./render"

const token = (value: string) => value as ChatActionToken

const chart = (imageUrl: string | null): ChatBlock => ({
	kind: "chart",
	spec: { type: "ranked", data: [{ name: "checkout", value: 4 }] },
	unit: "number",
	title: "Errors by service",
	summary: "1 item, highest checkout (4)",
	imageUrl,
})

describe("renderDiscordMessage", () => {
	it("writes prose, a linked entity and a status line into one body", () => {
		const payload = renderDiscordMessage([
			{ kind: "prose", markdown: "Checkout is slow." },
			{
				kind: "entity",
				entity: "service",
				label: "checkout",
				detail: "p95 1.20s",
				url: "https://app.maple.dev/services/checkout",
			},
			{ kind: "activity", tools: [{ label: "Looking for errors", status: "running", detail: null }] },
		])

		expect(payload.content).toBe(
			[
				"Checkout is slow.",
				"> **Service** [checkout](https://app.maple.dev/services/checkout)\n> p95 1.20s",
				"Looking for errors…",
			].join("\n\n"),
		)
		// Nothing the model writes may notify a server.
		expect(payload.allowed_mentions).toEqual({ parse: [] })
	})

	it("shows a chart as an embed when there is an image, and as a line when there is not", () => {
		const withImage = renderDiscordMessage([chart("https://img.maple.dev/a1/0.png")])
		expect(withImage.embeds).toEqual([
			{
				title: "Errors by service",
				description: "1 item, highest checkout (4)",
				image: { url: "https://img.maple.dev/a1/0.png" },
			},
		])
		expect(withImage.content).toBe("")

		const withoutImage = renderDiscordMessage([chart(null)])
		expect(withoutImage.embeds).toEqual([])
		expect(withoutImage.content).toBe("**Errors by service** — 1 item, highest checkout (4)")
	})

	it("carries the action token through both buttons' custom ids", () => {
		const payload = renderDiscordMessage([
			{
				kind: "approval",
				toolName: "create_alert_rule",
				summary: "name: checkout p95",
				token: token("org_1:bot-42|call_9"),
				outcome: null,
			},
		])

		expect(payload.components).toEqual([
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 3,
						label: "Run create_alert_rule",
						custom_id: "approve:org_1:bot-42|call_9",
					},
					{ type: 2, style: 4, label: "Skip", custom_id: "deny:org_1:bot-42|call_9" },
				],
			},
		])
	})

	it("takes the buttons off a proposal somebody decided, and says what came of it", () => {
		const payload = renderDiscordMessage([
			{
				kind: "approval",
				toolName: "create_alert_rule",
				summary: "name: checkout p95",
				token: token("org_1:bot-42|call_9"),
				outcome: { approved: true, text: "Approved by Ada.\nCreated alert rule." },
			},
		])

		// Discord leaves a component clickable forever, so the row has to go rather than be styled
		// as spent.
		expect(payload.components).toEqual([])
		expect(payload.content).toBe(
			"**`create_alert_rule`**\nname: checkout p95\nApproved by Ada.\nCreated alert rule.",
		)
	})

	it("drops the buttons rather than sending a custom id Discord would reject", () => {
		const payload = renderDiscordMessage([
			{
				kind: "approval",
				toolName: "create_alert_rule",
				summary: "",
				token: token(`org_1:bot-42|${"c".repeat(120)}`),
				outcome: null,
			},
		])

		expect(payload.components).toEqual([])
		expect(payload.content).toContain("has to be approved in Maple")
	})

	it("stops at the action rows a message may carry, rather than losing the message", () => {
		const approvals = Array.from({ length: 7 }, (_, index) => ({
			kind: "approval" as const,
			toolName: `tool_${index}`,
			summary: "",
			token: token(`org_1:bot-42|call_${index}`),
			outcome: null,
		}))
		const payload = renderDiscordMessage(approvals)

		expect(payload.components).toHaveLength(MAX_ACTION_ROWS)
		expect(payload.content.match(/has to be approved in Maple/g)).toHaveLength(2)
	})

	it("clamps embed fields the model had no reason to keep short", () => {
		const payload = renderDiscordMessage([
			{
				...(chart("https://img.maple.dev/a.png") as Extract<ChatBlock, { kind: "chart" }>),
				title: "t".repeat(400),
			},
		])

		expect(payload.embeds[0].title).toHaveLength(256)
	})

	it("falls back to text once the embeds together would be too long", () => {
		// Each embed is within its own limits; Discord bounds their COMBINED text as well, and
		// rejects the whole message over it.
		const wide = (index: number): ChatBlock => ({
			...(chart(`https://img.maple.dev/${index}.png`) as Extract<ChatBlock, { kind: "chart" }>),
			summary: "s".repeat(3000),
		})
		const payload = renderDiscordMessage([wide(0), wide(1), wide(2)])

		expect(payload.embeds.length).toBeLessThan(3)
		const spent = payload.embeds.reduce(
			(total, embed) => total + (embed.title?.length ?? 0) + (embed.description?.length ?? 0),
			0,
		)
		expect(spent).toBeLessThanOrEqual(6000)
		// The chart a budget pushed out is still reported, as the line it would have had anyway.
		expect(payload.content).toContain("Errors by service")
	})

	it("gives an emptied message something Discord accepts", () => {
		expect(renderDiscordMessage([]).content).toBe(EMPTY_CONTENT)
	})

	it("clamps a body the neutral cut underestimated", () => {
		const payload = renderDiscordMessage([
			{ kind: "prose", markdown: "x".repeat(MAX_CONTENT_CHARS + 50) },
		])
		expect(payload.content).toHaveLength(MAX_CONTENT_CHARS)
		expect(payload.content.endsWith("…")).toBe(true)
	})
})
