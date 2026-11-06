import type { AlertDestinationRow } from "@maple/db/tables"
import { AlertDestinationId, parseTeamsWorkflowWebhookUrl, teamsWebhookUrlProblem } from "@maple/domain/http"
import { OrgId } from "@maple/domain/primitives"
import { assert, describe, it } from "@effect/vitest"
import { Option, Schema, String as Str } from "effect"
import type { DispatchContext } from "../context"
import type { RenderInput, SecretConfigOf } from "../Transport"
import { microsoftTeamsTransport } from "./microsoft-teams"

const WEBHOOK_URL =
	"https://default0a1b2c3d4e5f.47.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/9f8e7d6c5b4a39281706f5e4d3c2b1a0/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=s1gn4ture"

const destinationRow: AlertDestinationRow = {
	id: Schema.decodeSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726"),
	orgId: Schema.decodeSync(OrgId)("org_1"),
	name: "Ops channel",
	type: "microsoft-teams",
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

const config: SecretConfigOf<"microsoft-teams"> = { type: "microsoft-teams", webhookUrl: WEBHOOK_URL }

const context: DispatchContext = {
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow,
	publicConfig: { summary: "Workflow 9f8e7d6c…", channelLabel: null },
	secretConfig: config,
	ruleId: "rule_1",
	ruleName: "Checkout [errors](https://evil.test) *rate*",
	groupKey: "checkout_api",
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
	chartUrl: "https://web.localhost/alerts/chart/abc.png",
}

const LINK = "https://web.localhost/alerts/rule_1"
const CHAT = "https://web.localhost/chat?alert=rule_1"

const render = (overrides: Partial<RenderInput<typeof config>> = {}) =>
	microsoftTeamsTransport.render({
		config,
		context,
		linkUrl: LINK,
		chatUrl: CHAT,
		payloadJson: "{}",
		templated: null,
		...overrides,
	})

const cardOf = (body: string) => JSON.parse(body).attachments[0].content

describe("parseTeamsWorkflowWebhookUrl", () => {
	it("reads the workflow from a Workflows webhook URL", () => {
		assert.deepStrictEqual(
			parseTeamsWorkflowWebhookUrl(`  ${WEBHOOK_URL} `),
			Option.some({ workflowId: "9f8e7d6c5b4a39281706f5e4d3c2b1a0" }),
		)
	})

	it("rejects URLs that are not a signed Workflows trigger on the Power Platform host", () => {
		const rejected = [
			Str.replace("https://", "http://")(WEBHOOK_URL),
			Str.replace("&sig=s1gn4ture", "")(WEBHOOK_URL),
			Str.replace("/paths/invoke", "/paths/other")(WEBHOOK_URL),
			Str.replace(":443", ":8443")(WEBHOOK_URL),
			Str.replace("https://", "https://user:pass@")(WEBHOOK_URL),
			Str.replace(
				".environment.api.powerplatform.com",
				".environment.api.powerplatform.com.evil.test",
			)(WEBHOOK_URL),
			`https://evil.test/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x&h=.environment.api.powerplatform.com`,
			"https://environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x",
			"not a url",
		]
		for (const raw of rejected) assert.isTrue(Option.isNone(parseTeamsWorkflowWebhookUrl(raw)), raw)
	})

	it("names the two retired URL kinds people still paste", () => {
		assert.strictEqual(
			teamsWebhookUrlProblem(
				"https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/x/y",
			),
			"retired-connector",
		)
		assert.strictEqual(
			teamsWebhookUrlProblem(
				"https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x",
			),
			"retired-logic-apps",
		)
		assert.strictEqual(teamsWebhookUrlProblem("https://example.test/hook"), "invalid")
		assert.isNull(teamsWebhookUrlProblem(WEBHOOK_URL))
	})
})

describe("microsoftTeamsTransport.render", () => {
	it("posts an Adaptive Card message to the configured flow through the SSRF guard", () => {
		const spec = render()
		assert.strictEqual(spec.url, WEBHOOK_URL)
		assert.isTrue(spec.guarded)
		const body = JSON.parse(spec.body)
		assert.strictEqual(body.type, "message")
		assert.lengthOf(body.attachments, 1)
		assert.strictEqual(body.attachments[0].contentType, "application/vnd.microsoft.card.adaptive")
		assert.isNull(body.attachments[0].contentUrl)
		assert.strictEqual(body.attachments[0].content.type, "AdaptiveCard")
	})

	it("shows the alert's state in the header band and the facts", () => {
		const styleAndStatus = (overrides: Partial<DispatchContext>) => {
			const card = cardOf(render({ context: { ...context, ...overrides } }).body)
			const facts = card.body.find((block: { type: string }) => block.type === "FactSet").facts
			return [card.body[0].style, facts[0].value]
		}
		assert.deepStrictEqual(styleAndStatus({}), ["attention", "Triggered"])
		assert.deepStrictEqual(styleAndStatus({ severity: "warning" }), ["warning", "Triggered"])
		assert.deepStrictEqual(styleAndStatus({ eventType: "resolve" }), ["good", "Resolved"])
		assert.deepStrictEqual(styleAndStatus({ eventType: "test" }), ["accent", "Test"])
	})

	it("links to the alert and to Maple AI", () => {
		const card = cardOf(render().body)
		assert.deepStrictEqual(card.actions, [
			{ type: "Action.OpenUrl", title: "Open in Maple", url: LINK },
			{ type: "Action.OpenUrl", title: "Ask Maple AI", url: CHAT },
		])
		assert.deepInclude(card.body, {
			type: "Image",
			url: "https://web.localhost/alerts/chart/abc.png",
			altText: `${context.ruleName} over the alert window`,
			size: "Stretch",
		})
	})

	it("keeps a rule name or group from turning into Markdown links or emphasis", () => {
		const card = cardOf(render().body)
		const title: string = card.body[0].items[0].text
		assert.include(title, "\\[errors\\](https://evil.test) \\*rate\\*")
		const facts = card.body.find((block: { type: string }) => block.type === "FactSet").facts
		assert.deepInclude(facts, { title: "Group", value: "checkout\\_api" })
	})

	it("passes a template's Markdown body through and drops the built-in facts", () => {
		const card = cardOf(
			render({ templated: { title: "Checkout is down", body: "**Page** the [owner](https://x.test)" } })
				.body,
		)
		assert.strictEqual(card.body[1].text, "**Page** the [owner](https://x.test)")
		assert.isUndefined(card.body.find((block: { type: string }) => block.type === "FactSet"))
	})

	it("stays under Teams' 28 KB message limit with a maximal template", () => {
		const spec = render({ templated: { title: Str.repeat(4000)("t"), body: Str.repeat(4000)("b") } })
		assert.isBelow(new TextEncoder().encode(spec.body).length, 28 * 1024)
	})
})
