/**
 * Fake connectors, for testing the host against the contract rather than
 * against a platform.
 *
 * The ids are neutral (`testchat`, `testhook`) on purpose: a test that named a
 * real vendor would be one more place a customer adding a connector has to read,
 * and the vendor-isolation guard would reject it anyway.
 */
import type { ChatConnector, ConnectorConfig, InboundEvent, SocketStep } from "@maple/chat-platform"
import { ConnectorIngressError, makeChatConnectorId, socketIngress } from "@maple/chat-platform"
import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

export const TEST_SOCKET_ID = makeChatConnectorId("testchat")
export const TEST_WEBHOOK_ID = makeChatConnectorId("testhook")
export const TEST_TOKEN_KEY = "MAPLE_TESTCHAT_TOKEN"

export const testMessage: InboundEvent = {
	type: "message",
	connector: TEST_SOCKET_ID,
	workspaceId: "workspace-1",
	channelId: "channel-1",
	messageId: "message-1",
	author: { id: "author-1", displayName: "Someone", isBot: false },
	text: "hello",
	mentionsBot: true,
}

/** A protocol with no behaviour: every input echoes back what the test asked for. */
const TestState = Schema.Struct({ seen: Schema.Number })

export const testSocketConnector = (
	step: (state: { seen: number }) => SocketStep<{ seen: number }> = (state) => ({ state }),
): ChatConnector => ({
	id: TEST_SOCKET_ID,
	ingress: socketIngress({
		requiredConfig: [{ name: TEST_TOKEN_KEY, secret: true }],
		stateSchema: Schema.fromJsonString(TestState),
		initialState: { seen: 0 },
		connectUrl: () => "wss://socket.test/gateway",
		onOpen: (state) => step(state),
		onFrame: (state) => step(state),
		onClose: (state) => step(state),
		heartbeat: (state) => step(state),
	}),
})

export const testWebhookConnector = (
	handle: (config: ConnectorConfig) => Effect.Effect<
		{ response: HttpServerResponse.HttpServerResponse; events: ReadonlyArray<InboundEvent> },
		ConnectorIngressError
	> = () => Effect.succeed({ response: HttpServerResponse.text("ok"), events: [] }),
): ChatConnector => ({
	id: TEST_WEBHOOK_ID,
	ingress: {
		kind: "webhook",
		requiredConfig: [{ name: TEST_TOKEN_KEY, secret: true }],
		handle: (_request, config) => handle(config),
	},
})

export const rejectingWebhookConnector = (): ChatConnector =>
	testWebhookConnector(() =>
		Effect.fail(
			new ConnectorIngressError({
				connector: TEST_WEBHOOK_ID,
				message: "signature did not verify",
			}),
		),
	)
