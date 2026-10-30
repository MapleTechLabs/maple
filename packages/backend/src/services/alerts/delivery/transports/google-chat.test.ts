import type { AlertDestinationRow } from "@maple/db/tables"
import { AlertDestinationId, parseGoogleChatWebhookUrl } from "@maple/domain/http"
import { OrgId } from "@maple/domain/primitives"
import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import type { DispatchContext } from "../context"
import type { RenderInput, SecretConfigOf } from "../Transport"
import { googleChatTransport } from "./google-chat"

const WEBHOOK_URL =
	"https://chat.googleapis.com/v1/spaces/AAAAbc-12_x/messages?key=api-key&token=secret-token"

const destinationRow: AlertDestinationRow = {
	id: Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726"),
	orgId: Schema.decodeSync(OrgId)("org_1"),
	name: "Ops space",
	type: "google-chat",
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

const config: SecretConfigOf<"google-chat"> = { type: "google-chat", webhookUrl: WEBHOOK_URL }

const context: DispatchContext = {
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow,
	publicConfig: { summary: "Space AAAAbc-12_x", channelLabel: null },
	secretConfig: config,
	ruleId: "rule_1",
	ruleName: "Checkout <error> rate",
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
	chartUrl: "https://web.localhost/alerts/chart/abc.png",
}

const render = (overrides: Partial<RenderInput<typeof config>> = {}) =>
	googleChatTransport.render({
		config,
		context,
		linkUrl: "https://web.localhost/alerts/rule_1",
		chatUrl: "https://web.localhost/chat?alert=rule_1",
		payloadJson: "{}",
		templated: null,
		...overrides,
	})

const widgetsOf = (body: string) => JSON.parse(body).cardsV2[0].card.sections[0].widgets

describe("parseGoogleChatWebhookUrl", () => {
	it("reads the space from a webhook URL Google Chat hands out", () => {
		assert.deepStrictEqual(
			parseGoogleChatWebhookUrl(`  ${WEBHOOK_URL} `),
			Option.some({ spaceId: "AAAAbc-12_x" }),
		)
	})

	it.each([
		["another host", "https://evil.test/v1/spaces/AAAA/messages?key=k&token=t"],
		["plain http", "http://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t"],
		["no token", "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k"],
		["an empty token", "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token="],
		["a space link", "https://chat.google.com/room/AAAA"],
		["not a URL", "secret-token"],
	])("rejects %s", (_label, url) => {
		assert.isTrue(Option.isNone(parseGoogleChatWebhookUrl(url)))
	})
})

describe("googleChatTransport.render", () => {
	it("posts to the webhook, replying in the alert's thread", () => {
		const url = new URL(render().url)
		assert.strictEqual(url.searchParams.get("token"), "secret-token")
		assert.strictEqual(url.searchParams.get("messageReplyOption"), "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")
		assert.strictEqual(JSON.parse(render().body).thread.threadKey, "org_1:rule_1:checkout")
	})

	it("escapes alert values inside the card's HTML text", () => {
		const widgets = widgetsOf(render({ context: { ...context, groupKey: "a<b>&c" } }).body)
		const texts = widgets.flatMap(
			(widget: { textParagraph?: { text: string }; decoratedText?: { text: string } }) =>
				widget.textParagraph?.text ?? widget.decoratedText?.text ?? [],
		)
		assert.include(texts, "a&lt;b&gt;&amp;c")
		assert.isFalse(texts.some((text: string) => text.includes("a<b>")))
	})

	it("carries the chart and both links", () => {
		const widgets = widgetsOf(render().body)
		const image = widgets.find((widget: { image?: unknown }) => widget.image !== undefined)
		assert.strictEqual(image.image.imageUrl, "https://web.localhost/alerts/chart/abc.png")
		const buttons = widgets.find((widget: { buttonList?: unknown }) => widget.buttonList !== undefined)
		assert.deepStrictEqual(
			buttons.buttonList.buttons.map(
				(button: { onClick: { openLink: { url: string } } }) => button.onClick.openLink.url,
			),
			["https://web.localhost/alerts/rule_1", "https://web.localhost/chat?alert=rule_1"],
		)
	})

	it("uses a rule's template as the title and body, without the detail rows", () => {
		const body = JSON.parse(
			render({ templated: { title: "Custom title", body: "line <1>\nline 2" } }).body,
		)
		assert.strictEqual(body.text, "Custom title")
		assert.strictEqual(body.cardsV2[0].card.header.title, "Custom title")
		const widgets = widgetsOf(JSON.stringify(body))
		assert.strictEqual(widgets[0].textParagraph.text, "line &lt;1&gt;<br>line 2")
		assert.isFalse(
			widgets.some((widget: { decoratedText?: unknown }) => widget.decoratedText !== undefined),
		)
	})

	it("renders a template's bold and http links, and nothing else", () => {
		const body = JSON.parse(
			render({
				templated: {
					title: "t",
					body: "**checkout** > 5% [runbook](https://docs.test/r) [x](javascript:alert(1))",
				},
			}).body,
		)
		assert.strictEqual(
			body.cardsV2[0].card.sections[0].widgets[0].textParagraph.text,
			'<b>checkout</b> &gt; 5% <a href="https://docs.test/r">runbook</a> [x](javascript:alert(1))',
		)
	})

	it("does not let a rule name mention the whole space", () => {
		const body = JSON.parse(render({ context: { ...context, ruleName: "<users/all> checkout" } }).body)
		assert.notInclude(body.text, "<users/all>")
		assert.include(body.text, "checkout")
	})

	it("says what a revoked or deleted webhook means", () => {
		assert.include(googleChatTransport.describeStatus?.(404) ?? "", "no longer exists")
		assert.isNull(googleChatTransport.describeStatus?.(500) ?? null)
	})
})
