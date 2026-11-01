import { describe, expect, it } from "vitest"
import type { ConnectorConfig } from "../../ingress.ts"
import { socketIngress } from "../../ingress.ts"
import { BOT_TOKEN_CONFIG, GATEWAY_URL } from "./api.ts"
import { gatewayProtocol, type GatewayState } from "./gateway.ts"
import { SESSION_CONFLICT_REASON } from "./gateway-payloads.ts"

const config: ConnectorConfig = new Map([[BOT_TOKEN_CONFIG, "hzl_bot_token"]])
const NOW = 1_700_000_000_000
const BOT_USER = "11111111-1111-4111-8111-111111111111"
const ADA = "22222222-2222-4222-8222-222222222222"
const ORG = "33333333-3333-4333-8333-333333333333"
const CHANNEL = "44444444-4444-4444-8444-444444444444"

const ready = (overrides: Partial<GatewayState> = {}): GatewayState => ({
	awaitingAck: false,
	sessionId: "session-1",
	offset: "0000000000000007",
	heartbeatIntervalMs: 25_000,
	botUserId: BOT_USER,
	...overrides,
})

const frame = (payload: Record<string, unknown>): string => JSON.stringify(payload)
const sent = (raw: string | undefined): Record<string, unknown> => JSON.parse(raw ?? "{}")

const messageCreate = (content: string, overrides: Record<string, unknown> = {}) => ({
	schemaVersion: 1,
	deliveryId: "d1",
	partitionKey: `org:${ORG}:channel:${CHANNEL}`,
	occurredAt: NOW,
	idempotencyKey: "k1",
	eventType: "message.create",
	payload: {
		id: "55555555-5555-4555-8555-555555555555",
		channelId: CHANNEL,
		authorId: ADA,
		content,
		embeds: null,
		replyToMessageId: null,
		threadChannelId: null,
		createdAt: new Date(NOW).toISOString(),
		updatedAt: null,
		deletedAt: null,
	},
	author: { id: ADA, displayName: "Ada Lovelace", isBot: false },
	...overrides,
})

const dispatch = (events: ReadonlyArray<unknown>, nextOffset = "0000000000000008") =>
	frame({ op: "DISPATCH", sessionId: "session-1", events, nextOffset })

describe("the handshake", () => {
	it("waits for HELLO, then identifies from new events only", () => {
		const opened = gatewayProtocol.onOpen({ awaitingAck: false }, NOW)
		expect(opened.send).toBeUndefined()
		expect(opened.heartbeatAt).toBe(NOW + 20_000)
		const hello = gatewayProtocol.onFrame(
			opened.state,
			frame({ op: "HELLO", heartbeatIntervalMs: 25_000 }),
			NOW,
			config,
		)
		expect(hello.send?.map(sent)).toEqual([
			{ op: "IDENTIFY", botToken: "hzl_bot_token", resumeOffset: "now" },
		])
		expect(hello.heartbeatAt).toBe(NOW + 25_000)
		expect(gatewayProtocol.connectUrl(hello.state, config)).toBe(GATEWAY_URL)
	})

	it("resumes a held session from the last acknowledged offset", () => {
		const hello = gatewayProtocol.onFrame(
			ready({ heartbeatIntervalMs: undefined }),
			frame({ op: "HELLO", heartbeatIntervalMs: 25_000 }),
			NOW,
			config,
		)
		expect(hello.send?.map(sent)).toEqual([
			{
				op: "RESUME",
				botToken: "hzl_bot_token",
				sessionId: "session-1",
				resumeOffset: "0000000000000007",
			},
		])
	})

	it("learns the session and the bot's own user from READY", () => {
		const step = gatewayProtocol.onFrame(
			{ awaitingAck: false, heartbeatIntervalMs: 25_000 },
			frame({
				op: "READY",
				sessionId: "s2",
				resumed: false,
				resumeOffset: "now",
				botId: "b",
				botUserId: BOT_USER,
			}),
			NOW,
			config,
		)
		expect(step.state).toMatchObject({ sessionId: "s2", botUserId: BOT_USER })
	})
})

describe("dispatch", () => {
	it("acknowledges each batch at once and remembers where it got to", () => {
		const step = gatewayProtocol.onFrame(ready(), dispatch([]), NOW, config)
		expect(step.send?.map(sent)).toEqual([
			{ op: "ACK", sessionId: "session-1", nextOffset: "0000000000000008" },
		])
		expect(step.state.offset).toBe("0000000000000008")
	})

	it("reports a mention without the bot's own markup, named after its author", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			dispatch([messageCreate(`@[userId:${BOT_USER}] why is checkout slow?`)]),
			NOW,
			config,
		)
		expect(step.events).toEqual([
			{
				type: "message",
				connector: "hazel",
				workspaceId: ORG,
				channelId: CHANNEL,
				messageId: "55555555-5555-4555-8555-555555555555",
				author: { id: ADA, displayName: "Ada Lovelace", isBot: false },
				text: "why is checkout slow?",
				mentionsBot: true,
			},
		])
	})

	it("keeps the question's line breaks and indentation when it strips the mention", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			dispatch([
				messageCreate(`@[userId:${BOT_USER}]  what does this mean?\n\n    Error: pool exhausted\n`),
			]),
			NOW,
			config,
		)
		expect(step.events?.[0]).toMatchObject({ text: "what does this mean?\n\n    Error: pool exhausted" })
	})

	it("keeps the first line's indentation when the mention sits alone above it", () => {
		const texts = [
			`@[userId:${BOT_USER}]\n    Error: pool exhausted`,
			`is @[userId:${BOT_USER}] around?`,
			`  @[userId:${BOT_USER}] hi`,
		].map((content) => {
			const step = gatewayProtocol.onFrame(ready(), dispatch([messageCreate(content)]), NOW, config)
			return step.events?.[0]?.type === "message" ? step.events[0].text : undefined
		})
		expect(texts).toEqual(["    Error: pool exhausted", "is around?", "hi"])
	})

	it("reports an unaddressed message too, and drops its own, other bots' and empty ones", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			dispatch([
				messageCreate("and the payments call?"),
				messageCreate("I answered", {
					payload: { ...messageCreate("").payload, authorId: BOT_USER },
				}),
				messageCreate("beep", { author: { id: "x", displayName: "CI", isBot: true } }),
				messageCreate("   "),
				{ eventType: "message.update", payload: {} },
				{ eventType: "channel.create", payload: {} },
				"not an envelope",
			]),
			NOW,
			config,
		)
		expect(
			step.events?.map((event) => event.type === "message" && [event.text, event.mentionsBot]),
		).toEqual([["and the payments call?", false]])
	})

	it("drops messages until it knows which mention is its own", () => {
		const step = gatewayProtocol.onFrame(
			ready({ botUserId: undefined }),
			dispatch([messageCreate(`@[userId:${BOT_USER}] hi`)]),
			NOW,
			config,
		)
		expect(step.events).toEqual([])
		expect(step.send).toHaveLength(1)
	})

	it("reports a button press with the id Maple put on it", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			dispatch([
				{
					eventType: "interaction.create",
					payload: {
						interactionId: "i1",
						actionId: "approve:call_1",
						messageId: "m1",
						channelId: CHANNEL,
						orgId: ORG,
						userId: ADA,
						userName: "Ada Lovelace",
						timestamp: NOW,
					},
				},
			]),
			NOW,
			config,
		)
		expect(step.events).toEqual([
			{
				type: "action",
				connector: "hazel",
				workspaceId: ORG,
				channelId: CHANNEL,
				messageId: "m1",
				actionToken: "approve:call_1",
				actor: { id: ADA, displayName: "Ada Lovelace" },
			},
		])
	})
})

describe("keeping the connection", () => {
	it("heartbeats on its session and reconnects when one goes unanswered", () => {
		const beat = gatewayProtocol.heartbeat(ready(), NOW)
		expect(beat.send?.map(sent)).toEqual([{ op: "HEARTBEAT", sessionId: "session-1" }])
		expect(beat.heartbeatAt).toBe(NOW + 25_000)
		const acked = gatewayProtocol.onFrame(beat.state, frame({ op: "HEARTBEAT_ACK" }), NOW, config)
		expect(acked.state.awaitingAck).toBe(false)
		expect(gatewayProtocol.heartbeat(beat.state, NOW + 25_000).directive?._tag).toBe("reconnect")
	})

	it("reconnects without a HELLO, on RECONNECT and on any close, keeping the session", () => {
		expect(gatewayProtocol.heartbeat({ awaitingAck: false }, NOW).directive?._tag).toBe("reconnect")
		const asked = gatewayProtocol.onFrame(
			ready(),
			frame({ op: "RECONNECT", reason: "ack_timeout" }),
			NOW,
			config,
		)
		expect(asked).toMatchObject({ state: { sessionId: "session-1" }, directive: { _tag: "reconnect" } })
		expect(gatewayProtocol.onClose(ready(), 1006, "")).toMatchObject({
			state: { sessionId: "session-1" },
			directive: { _tag: "reconnect" },
		})
	})

	it("stops on a refused token, keeps the session through a conflict, and forgets it otherwise", () => {
		const refused = gatewayProtocol.onFrame(
			ready(),
			frame({ op: "INVALID_SESSION", reason: "Invalid bot token" }),
			NOW,
			config,
		)
		expect(refused.directive?._tag).toBe("stop")
		const conflict = gatewayProtocol.onFrame(
			ready(),
			frame({ op: "INVALID_SESSION", reason: SESSION_CONFLICT_REASON }),
			NOW,
			config,
		)
		expect(conflict).toMatchObject({
			state: { sessionId: "session-1" },
			directive: { _tag: "reconnect" },
		})
		const replaced = gatewayProtocol.onFrame(
			ready(),
			frame({ op: "INVALID_SESSION", reason: "session resumed by another connection" }),
			NOW,
			config,
		)
		expect(replaced.state.sessionId).toBeUndefined()
		expect(replaced.state.offset).toBe("0000000000000007")
	})

	it("survives the host's persistence, and an unreadable frame changes nothing", () => {
		const ingress = socketIngress(gatewayProtocol)
		const step = ingress.onFrame(ingress.initialState, "{not json", NOW, config)
		expect(step.state).toBe(ingress.initialState)
		expect(ingress.onFrame("garbage", frame({ op: "HEARTBEAT_ACK" }), NOW, config).state).toBe(
			ingress.initialState,
		)
	})
})
