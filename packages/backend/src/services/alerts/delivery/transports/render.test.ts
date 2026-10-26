import type { AlertDestinationRow } from "@maple/db/tables"
import { OrgId } from "@maple/domain/primitives"
import { AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import type { DispatchContext } from "../context"
import type { HttpRequestSpec, RenderInput } from "../Transport"
import { discordTransport } from "./discord"
import { hazelTransport } from "./hazel"
import { pagerDutyTransport } from "./pagerduty"
import { telegramTransport } from "./telegram"
import { webhookTransport } from "./webhook"

/**
 * `render` is pure — no Effect, no fetch, no Clock — so a provider's wire shape
 * is assertable as a plain function call with no stub of any kind. That is the
 * point of the transport split: these cases used to need a fetch stub, a
 * destination row and a full deps bag each, which is why four of the six
 * providers had no coverage at all.
 */

const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat"

const destinationRow: AlertDestinationRow = {
	id: DESTINATION_ID,
	orgId: Schema.decodeSync(OrgId)("org_1"),
	name: "Destination",
	type: "webhook",
	enabled: true,
	configJson: {},
	secretCiphertext: "",
	secretIv: "",
	secretTag: "",
	lastTestedAt: null,
	lastTestError: null,
	consecutiveFailures: 0,
	lastFailureAt: null,
	disabledAt: null,
	disabledReason: null,
	createdAt: 0,
	updatedAt: 0,
	createdBy: "user_1",
	updatedBy: "user_1",
}

const context: DispatchContext = {
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow,
	publicConfig: { summary: "Checkout error rate", channelLabel: null },
	secretConfig: { type: "webhook", url: "https://unused.test", signingSecret: null },
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: "checkout",
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	eventType: "trigger",
	incidentId: "inc_1",
	incidentStatus: "open",
	dedupeKey: "org_1:rule_1:checkout",
	windowMinutes: 5,
	value: 0.08,
	sampleCount: 1200,
	template: null,
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
}

const inputFor = <Config>(
	config: Config,
	overrides: Partial<RenderInput<Config>> = {},
): RenderInput<Config> => ({
	config,
	context,
	linkUrl: LINK,
	chatUrl: CHAT,
	payloadJson: '{"canonical":"payload"}',
	templated: null,
	...overrides,
})

const TEMPLATED = { title: "Custom title", body: "Custom **body**" }

describe("transport render: guard flags", () => {
	/**
	 * `guarded` decides whether the request goes through the SSRF guard, and
	 * `sensitivePath` decides whether the URL path may appear on a span. Both are
	 * a function of where the host came from, so a provider getting either wrong
	 * is either an SSRF hole or a token leak into telemetry.
	 */
	const specs: ReadonlyArray<readonly [string, HttpRequestSpec]> = [
		["pagerduty", pagerDutyTransport.render(inputFor({ type: "pagerduty", integrationKey: "k" }))],
		[
			"webhook",
			webhookTransport.render(
				inputFor({ type: "webhook", url: "https://hooks.test/x", signingSecret: null }),
			),
		],
		[
			"discord",
			discordTransport.render(
				inputFor({ type: "discord", webhookUrl: "https://discord.com/api/w/1/tok" }),
			),
		],
		[
			"hazel-oauth",
			hazelTransport.render(
				inputFor({
					type: "hazel-oauth",
					hazelOrganizationId: "o",
					hazelOrganizationName: "Acme",
					hazelChannelId: "c",
					hazelChannelName: "ops",
					webhookId: "w",
					webhookUrl: "https://hazel.test/api/webhooks/w/tok",
					webhookToken: "tok",
				}),
			),
		],
		[
			"telegram",
			telegramTransport.render(
				inputFor({ type: "telegram", botToken: "123456789:AA-token", chatId: "-100123" }),
			),
		],
	]

	it("guards exactly the user-configured hosts", () => {
		const guarded = specs.filter(([, spec]) => spec.guarded).map(([name]) => name)
		// pagerduty + telegram post to compile-time vendor constants: there
		// is no attacker-controlled URL to validate, so the guard would only cost a
		// redirect walk.
		assert.deepStrictEqual(guarded, ["webhook", "discord", "hazel-oauth"])
	})

	it("marks exactly the providers whose token rides in the URL path", () => {
		const sensitive = specs.filter(([, spec]) => spec.sensitivePath).map(([name]) => name)
		// telegram is the first provider where this disagrees with `guarded`: a
		// fixed vendor host, but the bot token rides in the path.
		assert.deepStrictEqual(sensitive, ["discord", "hazel-oauth", "telegram"])
	})

	it("always produces a parseable JSON body", () => {
		for (const [name, spec] of specs) {
			assert.doesNotThrow(() => JSON.parse(spec.body), `${name} body must be JSON`)
		}
	})

	it("is deterministic — no Clock, no randomness in a render", () => {
		const render = () => pagerDutyTransport.render(inputFor({ type: "pagerduty", integrationKey: "k" }))
		assert.deepStrictEqual(render(), render())
	})
})

describe("transport render: templates", () => {
	it("discord uses the template title for both the content line and the embed", () => {
		const spec = discordTransport.render(
			inputFor(
				{ type: "discord", webhookUrl: "https://discord.com/api/w/1/tok" },
				{ templated: TEMPLATED },
			),
		)
		const body = JSON.parse(spec.body)
		assert.strictEqual(body.content, "Custom title")
		assert.strictEqual(body.embeds[0].title, "Custom title")
		assert.strictEqual(body.embeds[0].description, "Custom **body**")
	})

	it("pagerduty takes only the summary and a custom_details message from a template", () => {
		const spec = pagerDutyTransport.render(
			inputFor({ type: "pagerduty", integrationKey: "k" }, { templated: TEMPLATED }),
		)
		const body = JSON.parse(spec.body)
		assert.strictEqual(body.payload.summary, "Custom title")
		assert.strictEqual(body.payload.custom_details.message, "Custom **body**")
		// The envelope is fixed by the Events v2 API — a template cannot reshape it.
		assert.strictEqual(body.event_action, "trigger")
		assert.strictEqual(body.routing_key, "k")
	})

	it("webhook and hazel ignore templates — they ship the canonical payload", () => {
		for (const spec of [
			webhookTransport.render(
				inputFor(
					{ type: "webhook", url: "https://hooks.test/x", signingSecret: null },
					{ templated: TEMPLATED },
				),
			),
			hazelTransport.render(
				inputFor(
					{
						type: "hazel-oauth",
						hazelOrganizationId: "o",
						hazelOrganizationName: "Acme",
						hazelChannelId: "c",
						hazelChannelName: "ops",
						webhookId: "w",
						webhookUrl: "https://hazel.test/api/webhooks/w/tok",
						webhookToken: "tok",
					},
					{ templated: TEMPLATED },
				),
			),
		]) {
			assert.strictEqual(spec.body, '{"canonical":"payload"}')
		}
	})
})

/**
 * The sparkline is the one part of a renotify that differs from the message
 * before it, and it is the only trend that survives where an image cannot go —
 * a lock screen, a push preview, a plain-text client. Discord carries it on
 * both the default and the templated path, which used to be separate literals
 * that had already drifted apart once.
 */
describe("transport render: sparkline", () => {
	const SPARK = "▁▂▄▆█"
	const withSpark = { ...context, sparkline: SPARK }

	const discordBody = (ctx: DispatchContext, templated: typeof TEMPLATED | null) =>
		discordTransport.render({
			...inputFor({ type: "discord" as const, webhookUrl: "https://discord.com/api/w/1/tok" }),
			context: ctx,
			templated,
		}).body

	it("rides in the Discord footer on the default path", () => {
		assert.include(discordBody(withSpark, null), SPARK)
	})

	it("rides in the Discord footer on the templated path too", () => {
		assert.include(discordBody(withSpark, TEMPLATED), SPARK)
	})

	const CHART_URL = "https://web.localhost/alerts/chart/eyJhIjoxfQ.s1g.png"
	const withChart = { ...context, sparkline: SPARK, chartUrl: CHART_URL }

	it("puts the chart in the Discord embed image on both paths", () => {
		for (const templated of [null, TEMPLATED]) {
			assert.include(discordBody(withChart, templated), CHART_URL)
		}
	})

	it("keeps the sparkline even when the image is present", () => {
		// The embed image does not render on a lock screen or in a push preview;
		// the sparkline is what travels there.
		assert.include(discordBody(withChart, null), SPARK)
	})

	it("emits no image block when there is no chart URL", () => {
		for (const templated of [null, TEMPLATED]) {
			assert.notInclude(discordBody(withSpark, templated), '"image"')
		}
	})

	/**
	 * The degrade path, and the reason every step of the chart feature returns
	 * `null` rather than failing: no series must cost the picture and nothing
	 * else. A message that fails to render because a warehouse read timed out is
	 * a page that did not arrive.
	 */
	it("renders a complete message when there is no sparkline", () => {
		for (const templated of [null, TEMPLATED]) {
			const discordJson = discordBody(context, templated)
			assert.notInclude(discordJson, "undefined")
			assert.include(discordJson, "Maple Alerts")
		}
	})
})

describe("pagerduty dedup keys across severity tiers", () => {
	const pd = (overrides: Partial<DispatchContext>) => {
		const input = inputFor(
			{ type: "pagerduty" as const, integrationKey: "k" },
			{ context: { ...context, ...overrides } },
		)
		const sent = [pagerDutyTransport.render(input), ...(pagerDutyTransport.followUps?.(input) ?? [])]
		return sent.map((spec) => {
			const body = JSON.parse(spec.body)
			return `${body.event_action} ${body.dedup_key}`
		})
	}
	const tiered = { ruleSeverities: ["warning", "critical"] as const }

	it("keeps a single-tier rule on the incident's one key, with no extra requests", () => {
		assert.deepStrictEqual(pd({ ruleSeverities: ["critical"] }), ["trigger org_1:rule_1:checkout"])
		assert.deepStrictEqual(pd({ ruleSeverities: ["critical"], eventType: "resolve" }), [
			"resolve org_1:rule_1:checkout",
		])
	})

	it("pages a tiered rule's critical on its own key, so an acknowledged warning cannot swallow it", () => {
		assert.deepStrictEqual(pd({ ...tiered, severity: "warning" }), [
			"trigger org_1:rule_1:checkout",
			"resolve org_1:rule_1:checkout:critical",
		])
		assert.deepStrictEqual(pd({ ...tiered, severity: "critical" }), [
			"trigger org_1:rule_1:checkout:critical",
		])
	})

	it("closes the critical alert of an incident that peaked at critical after the rule dropped that tier", () => {
		assert.deepStrictEqual(
			pd({
				ruleSeverities: ["warning"],
				incidentPeakSeverity: "critical",
				severity: "warning",
				eventType: "renotify",
			}),
			["trigger org_1:rule_1:checkout", "resolve org_1:rule_1:checkout:critical"],
		)
		assert.deepStrictEqual(
			pd({ ruleSeverities: ["warning"], incidentPeakSeverity: "critical", eventType: "resolve" }),
			["resolve org_1:rule_1:checkout", "resolve org_1:rule_1:checkout:critical"],
		)
	})

	it("leaves the critical page open when a warning event is delivered after an escalation", () => {
		assert.deepStrictEqual(
			pd({ ...tiered, severity: "warning", eventType: "renotify", incidentSeverity: "critical" }),
			["trigger org_1:rule_1:checkout"],
		)
	})

	it("does not re-open the critical alert when a critical event is retried after a de-escalation", () => {
		assert.deepStrictEqual(pd({ ...tiered, severity: "critical", incidentSeverity: "warning" }), [
			"trigger org_1:rule_1:checkout",
			"resolve org_1:rule_1:checkout:critical",
		])
		// The warning alert it lands on is not raised to critical either.
		const spec = pagerDutyTransport.render(
			inputFor(
				{ type: "pagerduty", integrationKey: "k" },
				{ context: { ...context, ...tiered, severity: "critical", incidentSeverity: "warning" } },
			),
		)
		assert.strictEqual(JSON.parse(spec.body).payload.severity, "warning")
	})

	it("closes the critical alert on de-escalation and both alerts on resolve", () => {
		assert.deepStrictEqual(pd({ ...tiered, severity: "warning", eventType: "renotify" }), [
			"trigger org_1:rule_1:checkout",
			"resolve org_1:rule_1:checkout:critical",
		])
		assert.deepStrictEqual(pd({ ...tiered, severity: "critical", eventType: "resolve" }), [
			"resolve org_1:rule_1:checkout",
			"resolve org_1:rule_1:checkout:critical",
		])
	})
})

describe("transport render: uptime monitors", () => {
	const uptime: DispatchContext = {
		...context,
		ruleName: "checkout-api",
		groupKey: "checkout-api",
		signalType: "uptime",
		comparator: "gte",
		threshold: 1,
		windowMinutes: 1,
		value: 1,
		sampleCount: 1,
		detail: "Status 503, expected 2xx",
	}
	const uptimeInput = <Config>(config: Config, overrides: Partial<DispatchContext> = {}) =>
		inputFor(config, { context: { ...uptime, ...overrides } })
	const discord = (overrides: Partial<DispatchContext> = {}) =>
		Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					content: Schema.String,
					embeds: Schema.Array(
						Schema.Struct({
							title: Schema.String,
							fields: Schema.Array(
								Schema.Struct({ name: Schema.String, value: Schema.String }),
							),
						}),
					),
				}),
			),
		)(
			discordTransport.render(
				uptimeInput({ type: "discord", webhookUrl: "https://discord.com/api/w/1/tok" }, overrides),
			).body,
		)

	it("leads with the monitor being down and says why, not a threshold", () => {
		const body = discord()
		assert.strictEqual(body.content, "**checkout-api is down**")
		assert.strictEqual(body.embeds[0]?.title, "\u{1F6A8} checkout-api is down")
		assert.deepStrictEqual(
			body.embeds[0]?.fields.find((field) => field.name === "Observed"),
			{ name: "Observed", value: "Status 503, expected 2xx" },
		)
	})

	it("reads as back up on recovery and still down on a reminder", () => {
		assert.strictEqual(
			discord({ eventType: "resolve", value: 0, detail: "The check is passing" }).embeds[0]?.title,
			"✅ checkout-api is back up",
		)
		assert.strictEqual(
			discord({ eventType: "renotify" }).embeds[0]?.title,
			"\u{1F514} checkout-api is still down",
		)
	})

	it("puts the check's error in the PagerDuty summary and details", () => {
		const body = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					payload: Schema.Struct({
						summary: Schema.String,
						custom_details: Schema.Struct({ detail: Schema.String }),
					}),
				}),
			),
		)(pagerDutyTransport.render(uptimeInput({ type: "pagerduty", integrationKey: "k" })).body)
		assert.strictEqual(body.payload.summary, "checkout-api is down: Status 503, expected 2xx.")
		assert.strictEqual(body.payload.custom_details.detail, "Status 503, expected 2xx")
	})

	it("writes the Telegram message from the check's error", () => {
		const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ text: Schema.String })))(
			telegramTransport.render(
				uptimeInput({ type: "telegram", botToken: "123456789:AA-token", chatId: "-100123" }),
			).body,
		)
		assert.isTrue(
			body.text.startsWith("\u{1F6A8} <b>checkout-api is down</b>\n\nStatus 503, expected 2xx."),
		)
	})
})
