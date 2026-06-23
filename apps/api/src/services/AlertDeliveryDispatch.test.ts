import type { AlertDestinationRow } from "@maple/db"
import { AlertDeliveryError } from "@maple/domain/http"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
	buildDiscordEmbedsFromTemplate,
	buildSlackBlocksFromTemplate,
	buildTemplateContext,
	dispatchDelivery,
	type DispatchContext,
	type TemplateRenderContext,
} from "./AlertDeliveryDispatch"
import { renderTemplate } from "./alert-templating/renderer"
import { DEFAULT_BODY_TEMPLATE, DEFAULT_TITLE_TEMPLATE } from "./alert-templating/defaultTemplates"

const baseContext: TemplateRenderContext = {
	ruleId: "rule_1" as TemplateRenderContext["ruleId"],
	ruleName: "Checkout error rate",
	eventType: "trigger",
	severity: "critical",
	signalType: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	value: 0.08,
	sampleCount: 1200,
	groupKey: null,
	windowMinutes: 5,
	incidentId: "inc_1" as TemplateRenderContext["incidentId"],
	incidentStatus: "open",
	dedupeKey: "dedupe_1",
	template: null,
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
}

const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat?mode=alert"

describe("buildTemplateContext", () => {
	const ctx = buildTemplateContext(baseContext, LINK, CHAT)

	it("exposes pre-formatted variables", () => {
		expect(ctx["rule.name"]).toBe("Checkout error rate")
		expect(ctx.severity).toBe("critical")
		expect(ctx["signal.label"]).toBe("Error Rate")
		expect(ctx["event.label"]).toBe("Triggered")
		expect(ctx["comparator.label"]).toBe(">")
		// error_rate values render as percentages
		expect(ctx.value).toBe("8%")
		expect(ctx.threshold).toBe("5%")
		expect(ctx["observed.summary"]).toBe("8% > 5%")
		expect(ctx.window).toBe("5m")
		expect(ctx.group).toBe("all")
		expect(ctx["links.app"]).toBe(LINK)
		expect(ctx["links.chat"]).toBe(CHAT)
		expect(ctx.sentAt).toBe("2026-06-02T00:00:00.000Z")
	})

	it("leaves thresholdUpper empty for non-range comparators", () => {
		expect(ctx.thresholdUpper).toBe("")
	})

	it("renders the default templates without any missing variables", () => {
		const title = renderTemplate(DEFAULT_TITLE_TEMPLATE, ctx)
		const body = renderTemplate(DEFAULT_BODY_TEMPLATE, ctx)
		expect(title.missing).toEqual([])
		expect(body.missing).toEqual([])
		expect(title.text).toContain("Checkout error rate")
		expect(title.text).toContain("Triggered")
		expect(body.text).toContain("*Observed:* 8% > 5%")
	})
})

describe("buildSlackBlocksFromTemplate", () => {
	it("renders a header + mrkdwn section + actions, converting markdown links", () => {
		const blocks = buildSlackBlocksFromTemplate(
			"My Title",
			"**bold** and [link](https://x.test)",
			baseContext,
			LINK,
			CHAT,
		)
		const header = blocks[0] as { type: string; text: { text: string } }
		const section = blocks[1] as { type: string; text: { type: string; text: string } }
		expect(header.type).toBe("header")
		expect(header.text.text).toBe("My Title")
		expect(section.type).toBe("section")
		expect(section.text.type).toBe("mrkdwn")
		// **bold** → *bold*, [link](url) → <url|link>
		expect(section.text.text).toBe("*bold* and <https://x.test|link>")
		expect(blocks.some((b) => (b as { type: string }).type === "actions")).toBe(true)
	})

	it("truncates an over-long Slack header", () => {
		const long = "x".repeat(200)
		const blocks = buildSlackBlocksFromTemplate(long, "body", baseContext, LINK, CHAT)
		const header = blocks[0] as { text: { text: string } }
		expect(header.text.text.length).toBeLessThanOrEqual(150)
	})
})

describe("buildDiscordEmbedsFromTemplate", () => {
	it("maps title/body to the embed and color-codes by severity", () => {
		const [embed] = buildDiscordEmbedsFromTemplate("T", "B", baseContext, LINK, CHAT) as Array<{
			title: string
			description: string
			color: number
			url: string
		}>
		expect(embed.title).toBe("T")
		expect(embed.description).toBe("B")
		expect(embed.url).toBe(LINK)
		// critical (non-resolve) → red
		expect(embed.color).toBe(0xe01e5a)
	})
})

describe("dispatchDelivery", () => {
	const destinationRow: AlertDestinationRow = {
		id: "dest_1" as AlertDestinationRow["id"],
		orgId: "org_1" as AlertDestinationRow["orgId"],
		name: "PagerDuty",
		type: "pagerduty",
		enabled: true,
		configJson: {},
		secretCiphertext: "",
		secretIv: "",
		secretTag: "",
		lastTestedAt: null,
		lastTestError: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		createdBy: "user_1",
		updatedBy: "user_1",
	}

	const pagerdutyContext: DispatchContext = {
		deliveryKey: "org_1:dest_1:test",
		destination: destinationRow,
		publicConfig: { summary: "Test alert", channelLabel: null },
		secretConfig: { type: "pagerduty", integrationKey: "not-a-valid-routing-key" },
		ruleId: "rule_1",
		ruleName: "Test alert",
		groupKey: null,
		signalType: "throughput",
		severity: "warning",
		comparator: "lt",
		threshold: 1,
		thresholdUpper: null,
		eventType: "test",
		incidentId: null,
		incidentStatus: "resolved",
		dedupeKey: "org_1:dest_1:test",
		windowMinutes: 5,
		value: 0,
		sampleCount: 0,
		template: null,
		sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
	}

	it("includes the provider's response body in the delivery error", async () => {
		const body =
			'{"status":"invalid event","message":"Event object is invalid","errors":["routing_key is invalid"]}'
		const fetchFn: typeof fetch = async () => new Response(body, { status: 400 })

		const error = await Effect.runPromise(
			Effect.flip(dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT)),
		)

		expect(error).toBeInstanceOf(AlertDeliveryError)
		expect(error.destinationType).toBe("pagerduty")
		expect(error.message).toContain("PagerDuty delivery failed with 400")
		// The PagerDuty rejection reason is now surfaced instead of swallowed.
		expect(error.message).toContain("routing_key is invalid")
	})
})
