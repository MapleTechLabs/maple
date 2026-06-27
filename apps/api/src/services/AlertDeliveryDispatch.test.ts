import type { AlertDestinationRow } from "@maple/db"
import { AlertDeliveryError } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
	buildAlertChatUrl,
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

describe("buildAlertChatUrl (Ask Maple AI link)", () => {
	it("targets the incident diagnosis page when an incident exists", () => {
		const url = buildAlertChatUrl("https://web.localhost", baseContext)
		assert.isTrue(
			url.startsWith("https://web.localhost/alerts/incidents/inc_1?alert="),
			url,
		)
	})

	it("falls back to the chat surface when there is no incident row", () => {
		const url = buildAlertChatUrl("https://web.localhost", { ...baseContext, incidentId: null })
		assert.isTrue(url.startsWith("https://web.localhost/chat?"), url)
		assert.include(url, "mode=alert")
	})
})

describe("buildTemplateContext", () => {
	const ctx = buildTemplateContext(baseContext, LINK, CHAT)

	it("exposes pre-formatted variables", () => {
		assert.strictEqual(ctx["rule.name"], "Checkout error rate")
		assert.strictEqual(ctx.severity, "critical")
		assert.strictEqual(ctx["signal.label"], "Error Rate")
		assert.strictEqual(ctx["event.label"], "Triggered")
		assert.strictEqual(ctx["comparator.label"], ">")
		// error_rate values render as percentages
		assert.strictEqual(ctx.value, "8%")
		assert.strictEqual(ctx.threshold, "5%")
		assert.strictEqual(ctx["observed.summary"], "8% > 5%")
		assert.strictEqual(ctx.window, "5m")
		assert.strictEqual(ctx.group, "all")
		assert.strictEqual(ctx["links.app"], LINK)
		assert.strictEqual(ctx["links.chat"], CHAT)
		assert.strictEqual(ctx.sentAt, "2026-06-02T00:00:00.000Z")
	})

	it("leaves thresholdUpper empty for non-range comparators", () => {
		assert.strictEqual(ctx.thresholdUpper, "")
	})

	it("renders the default templates without any missing variables", () => {
		const title = renderTemplate(DEFAULT_TITLE_TEMPLATE, ctx)
		const body = renderTemplate(DEFAULT_BODY_TEMPLATE, ctx)
		assert.deepStrictEqual(title.missing, [])
		assert.deepStrictEqual(body.missing, [])
		assert.include(title.text, "Checkout error rate")
		assert.include(title.text, "Triggered")
		assert.include(body.text, "*Observed:* 8% > 5%")
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
		assert.strictEqual(header.type, "header")
		assert.strictEqual(header.text.text, "My Title")
		assert.strictEqual(section.type, "section")
		assert.strictEqual(section.text.type, "mrkdwn")
		// **bold** → *bold*, [link](url) → <url|link>
		assert.strictEqual(section.text.text, "*bold* and <https://x.test|link>")
		assert.isTrue(blocks.some((b) => (b as { type: string }).type === "actions"))
	})

	it("truncates an over-long Slack header", () => {
		const long = "x".repeat(200)
		const blocks = buildSlackBlocksFromTemplate(long, "body", baseContext, LINK, CHAT)
		const header = blocks[0] as { text: { text: string } }
		assert.isAtMost(header.text.text.length, 150)
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
		assert.strictEqual(embed.title, "T")
		assert.strictEqual(embed.description, "B")
		assert.strictEqual(embed.url, LINK)
		// critical (non-resolve) → red
		assert.strictEqual(embed.color, 0xe01e5a)
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

	it.effect("includes the provider's response body in the delivery error", () =>
		Effect.gen(function* () {
			const body =
				'{"status":"invalid event","message":"Event object is invalid","errors":["routing_key is invalid"]}'
			const fetchFn: typeof fetch = async () => new Response(body, { status: 400 })

			const error = yield* Effect.flip(
				dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "pagerduty")
			assert.include(error.message, "PagerDuty delivery failed with 400")
			// The PagerDuty rejection reason is now surfaced instead of swallowed.
			assert.include(error.message, "routing_key is invalid")
		}),
	)
})
