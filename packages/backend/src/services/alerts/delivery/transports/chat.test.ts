import type { AlertDestinationRow } from "@maple/db"
import { ChatOutboundError, chatConnectorId, type ChatBlock } from "@maple/chat-platform"
import { AlertDestinationId, ChatWorkspaceId, OrgId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { chatDeliveryFailure } from "../../ChatAlertPoster"
import type { DispatchContext } from "../context"
import type { ChatAlertPost, EffectTransportDeps, RenderInput, SecretConfigOf } from "../Transport"
import { buildChatAlertBlocks, chatTransport } from "./chat"

/**
 * The `chat` destination above the connector: what it asks a connector to post, and how a
 * connector's refusal becomes the delivery queue's failure class. No platform is named here — the
 * connector is `testchat`, and what the platform does with the blocks is its own test's business.
 */

const ORG = Schema.decodeUnknownSync(OrgId)("org_1")
const WORKSPACE = Schema.decodeUnknownSync(ChatWorkspaceId)("11111111-1111-4111-8111-111111111111")
const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat"

const config: SecretConfigOf<"chat"> = {
	type: "chat",
	workspaceId: WORKSPACE,
	channelId: "channel-1",
	channelName: "incidents",
}

const destinationRow: AlertDestinationRow = {
	id: Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726"),
	orgId: ORG,
	name: "Incidents",
	type: "chat",
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
	createdAt: new Date(0),
	updatedAt: new Date(0),
	createdBy: "user_1",
	updatedBy: "user_1",
}

const context: DispatchContext = {
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow,
	publicConfig: { summary: "Acme Engineering", channelLabel: "#incidents" },
	secretConfig: config,
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
	sparkline: "▁▂▅▇",
}

const inputFor = (overrides: Partial<RenderInput<SecretConfigOf<"chat">>> = {}) => ({
	config,
	context,
	linkUrl: LINK,
	chatUrl: CHAT,
	payloadJson: "{}",
	templated: null,
	...overrides,
})

const markdownOf = (blocks: ReadonlyArray<ChatBlock>): string => {
	assert.strictEqual(blocks.length, 1)
	const [block] = blocks
	if (block?.kind !== "prose") throw new Error("expected one prose block")
	return block.markdown
}

const TESTCHAT = chatConnectorId("testchat")

const outboundError = (extra: {
	readonly status?: number
	readonly reason?: "auth" | "not_found" | "rejected"
}) => new ChatOutboundError({ message: "refused", connectorId: TESTCHAT, operation: "post", ...extra })

describe("chat alert blocks", () => {
	it("says what fired, what was observed, and where to look", () => {
		const markdown = markdownOf(buildChatAlertBlocks(inputFor()))
		assert.include(markdown, "**Checkout error rate** — Triggered")
		assert.include(markdown, "**Severity**")
		assert.include(markdown, "**Window** 5m")
		assert.include(markdown, "**Group** `checkout`")
		assert.include(markdown, "`▁▂▅▇`")
		assert.include(markdown, `[Open in Maple](${LINK})`)
		assert.include(markdown, `[Ask Maple AI](${CHAT})`)
	})

	it("leaves the group out of an ungrouped rule", () => {
		const markdown = markdownOf(
			buildChatAlertBlocks(inputFor({ context: { ...context, groupKey: "__total__" } })),
		)
		assert.notInclude(markdown, "**Group**")
	})

	it("uses the rule's own template in place of the title and summary", () => {
		const markdown = markdownOf(
			buildChatAlertBlocks(
				inputFor({ templated: { title: "Checkout is on fire", body: "Page **Ada**." } }),
			),
		)
		assert.isTrue(markdown.startsWith("**Checkout is on fire**"))
		assert.include(markdown, "Page **Ada**.")
		assert.notInclude(markdown, "**Severity**")
		assert.include(markdown, `[Open in Maple](${LINK})`)
	})
})

describe("chat transport", () => {
	it.effect("posts to the configured channel of the destination's own org, and quotes the message", () => {
		const posts: Array<ChatAlertPost> = []
		const deps: EffectTransportDeps = {
			sendEmail: () => Effect.die("the chat transport sent an email"),
			postChatAlert: (post) =>
				Effect.sync(() => {
					posts.push(post)
					return { connectorName: "Test Chat", messageId: "message-9" }
				}),
		}
		return Effect.gen(function* () {
			const result = yield* chatTransport.send(inputFor(), deps)
			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to Test Chat #incidents",
				providerReference: "message-9",
				responseCode: null,
			})
			assert.strictEqual(posts[0]?.orgId, ORG)
			assert.strictEqual(posts[0]?.workspaceId, WORKSPACE)
			assert.strictEqual(posts[0]?.channelId, "channel-1")
		})
	})
})

describe("chat delivery failures", () => {
	it("follows what the platform said was wrong", () => {
		assert.strictEqual(
			chatDeliveryFailure(outboundError({ reason: "auth", status: 200 }))._tag,
			"@maple/http/errors/AlertDeliveryAuthError",
		)
		assert.strictEqual(
			chatDeliveryFailure(outboundError({ reason: "not_found" }))._tag,
			"@maple/http/errors/AlertDeliveryTargetMissingError",
		)
		assert.strictEqual(
			chatDeliveryFailure(outboundError({ reason: "rejected" }))._tag,
			"@maple/http/errors/AlertDeliveryRejectedError",
		)
	})

	it("falls back to the status, and retries what nobody explained", () => {
		assert.strictEqual(
			chatDeliveryFailure(outboundError({ status: 403 }))._tag,
			"@maple/http/errors/AlertDeliveryAuthError",
		)
		const rateLimited = chatDeliveryFailure(outboundError({ status: 429 }))
		assert.strictEqual(rateLimited._tag, "@maple/http/errors/AlertDeliveryError")
		assert.isTrue(rateLimited.error.retryable)
		const unexplained = chatDeliveryFailure(outboundError({}))
		assert.strictEqual(unexplained._tag, "@maple/http/errors/AlertDeliveryError")
		assert.strictEqual(unexplained.destinationType, "chat")
	})
})
