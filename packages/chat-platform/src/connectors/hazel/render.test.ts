import { describe, expect, it } from "vitest"
import { encodeChatActionToken } from "../../action-token"
import { EMPTY_CONTENT, renderHazelLive, renderHazelMessage } from "./render"

describe("hazel render", () => {
	it("writes prose as markdown and never lets it mention anybody", () => {
		const body = renderHazelMessage([
			{ kind: "prose", markdown: "Checkout is slow. cc @[directive:channel] @[userId:abc]" },
		])
		expect(body.embeds).toEqual([])
		expect(body.content).toBe("Checkout is slow. cc @​[directive:channel] @​[userId:abc]")
	})

	it("puts an open approval on an embed with two buttons carrying Maple's control ids", () => {
		const body = renderHazelMessage([
			{
				kind: "approval",
				toolName: "restart_service",
				summary: "Restart checkout in production",
				token: encodeChatActionToken("call_1"),
				outcome: null,
			},
		])
		expect(body.embeds).toEqual([
			{
				title: "Approve restart_service?",
				description: "Restart checkout in production",
				actions: [
					{ id: "approve:call_1", label: "Run restart_service", style: "primary" },
					{ id: "deny:call_1", label: "Skip", style: "secondary" },
				],
			},
		])
	})

	it("leaves the buttons off an id Hazel would refuse, and off a decided proposal", () => {
		const long = renderHazelMessage([
			{
				kind: "approval",
				toolName: "restart_service",
				summary: "",
				token: encodeChatActionToken("c".repeat(120)),
				outcome: null,
			},
		])
		expect(long.embeds[0]).toEqual({
			title: "Approve restart_service?",
			footer: { text: "This one has to be approved in Maple." },
		})
		const decided = renderHazelMessage([
			{
				kind: "approval",
				toolName: "restart_service",
				summary: "",
				token: encodeChatActionToken("call_1"),
				outcome: { approved: true, decision: "Approved by Ada.", text: "Restarted.", url: null },
			},
		])
		expect(decided.embeds).toEqual([])
		expect(decided.content).toBe("Restarted.\n_Approved by Ada._")
	})

	it("shows a chart with an image as a card, and one without as its summary", () => {
		const chart = (imageUrl: string | null) =>
			renderHazelMessage([
				{
					kind: "chart",
					spec: {} as never,
					unit: "ms",
					title: "p95 latency",
					summary: "p95 over 24h",
					imageUrl,
				},
			])
		expect(chart("https://img/1.png").embeds).toEqual([
			{ title: "p95 latency", description: "p95 over 24h", image: { url: "https://img/1.png" } },
		])
		expect(chart(null).content).toBe("**p95 latency** — p95 over 24h")
	})

	it("renders an alert as a card with its link, facts and bar colour", () => {
		const body = renderHazelMessage([
			{
				kind: "alert",
				color: "#ff0000",
				title: "Error rate high",
				summary: "checkout errors at 5%",
				fields: [{ label: "Service", value: "checkout" }],
				imageUrl: null,
				imageAlt: "",
				links: [{ label: "Open alert", url: "https://app.maple.dev/a/1", primary: true }],
				footer: ["`prod`"],
				sentAtMs: 0,
			},
		])
		expect(body.embeds[0]).toEqual({
			title: "Error rate high",
			url: "https://app.maple.dev/a/1",
			color: 0xff0000,
			description: "checkout errors at 5%",
			fields: [
				{ name: "Service", value: "checkout", inline: true },
				{ name: "Links", value: "[Open alert](https://app.maple.dev/a/1)", inline: false },
			],
			footer: { text: "prod" },
			timestamp: "1970-01-01T00:00:00.000Z",
		})
	})

	it("says something when there is nothing to say yet", () => {
		expect(renderHazelMessage([])).toEqual({ content: EMPTY_CONTENT, embeds: [] })
	})

	it("streams the placeholder as Hazel's loading indicator rather than as text", () => {
		const body = renderHazelLive([{ kind: "notice", tone: "pending", text: "Working on it…" }])
		expect(body).toEqual({
			content: "_Working on it…_",
			embeds: [],
			text: "",
			error: null,
			loading: { text: "Working on it" },
		})
	})

	it("streams the text a turn ends on, and the failure it ends with as the live state's error", () => {
		const body = renderHazelLive([
			{ kind: "prose", markdown: "Checkout is slow because @[userId:abc]" },
			{ kind: "notice", tone: "error", text: "Failed: the model stopped answering" },
		])
		expect(body.text).toBe("Checkout is slow because @​[userId:abc]")
		expect(body.error).toBe("Failed: the model stopped answering")
		// The message itself still says it failed, for history and search.
		expect(body.content).toBe(
			"Checkout is slow because @​[userId:abc]\n\n**Failed: the model stopped answering**",
		)
		// Only the notice a turn closes on is a failure; one in the middle is just text.
		expect(
			renderHazelLive([
				{ kind: "notice", tone: "error", text: "A tool failed." },
				{ kind: "prose", markdown: "Answered anyway." },
			]).error,
		).toBeNull()
	})
})
