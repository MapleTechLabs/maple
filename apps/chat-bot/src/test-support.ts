/**
 * Fake connectors, for testing the host against the contract rather than
 * against a platform.
 *
 * The ids are neutral (`testchat`, `testhook`) on purpose: a test that named a
 * real vendor would be one more place a customer adding a connector has to read,
 * and the vendor-isolation guard would reject it anyway.
 */
import type {
	ConnectorConfig,
	InboundEvent,
	InboundMessage,
	SocketStep,
} from "@maple/chat-platform"
import type { IngressConnector } from "./config.ts"
import { ConnectorIngressError, chatConnectorId, socketIngress } from "@maple/chat-platform"
import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

export const TEST_SOCKET_ID = chatConnectorId("testchat")
export const TEST_WEBHOOK_ID = chatConnectorId("testhook")
export const TEST_TOKEN_KEY = "MAPLE_TESTCHAT_TOKEN"

/**
 * The text and the display name are deliberately unmistakable strings. They are
 * what `inbound.test.ts` searches the recorded telemetry for, and a fixture like
 * `"hello"` would let that search pass by being too ordinary to find.
 */
export const testMessage: InboundMessage = {
	type: "message",
	connector: TEST_SOCKET_ID,
	workspaceId: "workspace-1",
	channelId: "channel-1",
	messageId: "message-1",
	author: { id: "author-1", displayName: "Zeph-Quilby-Marlowe", isBot: false },
	text: "why-is-checkout-slow-vorpal-kestrel-9183",
	mentionsBot: true,
}

/** A protocol with no behaviour: every input hands the state straight back. */
const TestState = Schema.Struct({ seen: Schema.Number })
const unchanged = (state: { seen: number }): SocketStep<{ seen: number }> => ({ state })

export const testSocketConnector = (): IngressConnector => ({
	id: TEST_SOCKET_ID,
	ingress: socketIngress({
		requiredConfig: [{ name: TEST_TOKEN_KEY, secret: true }],
		stateSchema: Schema.fromJsonString(TestState),
		initialState: { seen: 0 },
		connectUrl: () => "wss://socket.test/gateway",
		onOpen: unchanged,
		onFrame: unchanged,
		onClose: unchanged,
		heartbeat: unchanged,
	}),
})

export const testWebhookConnector = (
	handle: (config: ConnectorConfig) => Effect.Effect<
		{ response: HttpServerResponse.HttpServerResponse; events: ReadonlyArray<InboundEvent> },
		ConnectorIngressError
	> = () => Effect.succeed({ response: HttpServerResponse.text("ok"), events: [] }),
): IngressConnector => ({
	id: TEST_WEBHOOK_ID,
	ingress: {
		kind: "webhook",
		requiredConfig: [{ name: TEST_TOKEN_KEY, secret: true }],
		handle: (_request, config) => handle(config),
	},
})

export const rejectingWebhookConnector = (): IngressConnector =>
	testWebhookConnector(() =>
		Effect.fail(
			new ConnectorIngressError({
				connector: TEST_WEBHOOK_ID,
				message: "signature did not verify",
			}),
		),
	)
