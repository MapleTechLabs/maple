import { describe, expect, it } from "vitest"
import type { ConnectorConfig } from "../../ingress.ts"
import { socketIngress } from "../../ingress.ts"
import { BOT_TOKEN, gatewayProtocol, type GatewayState } from "./gateway.ts"
import { INTENTS, MESSAGE_CONTENT_INTENT, OP } from "./gateway-payloads.ts"

const config: ConnectorConfig = new Map([[BOT_TOKEN, "bot-token"]])
const NOW = 1_700_000_000_000

const state = (overrides: Partial<GatewayState> = {}): GatewayState => ({
	awaitingAck: false,
	...overrides,
})

/** A connected, identified bot — the state most cases start from. */
const ready = (overrides: Partial<GatewayState> = {}): GatewayState =>
	state({
		sessionId: "session-1",
		resumeUrl: "wss://gateway-us-east1-b.discord.gg",
		sequence: 7,
		heartbeatIntervalMs: 41_250,
		botUserId: "900000000000000001",
		intents: INTENTS,
		...overrides,
	})

const frame = (payload: Record<string, unknown>): string => JSON.stringify(payload)
const sent = (raw: string | undefined): Record<string, unknown> => JSON.parse(raw ?? "{}")

const dispatch = (name: string, data: Record<string, unknown>, seq = 8): string =>
	frame({ op: OP.dispatch, t: name, s: seq, d: data })

const user = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	username: `user-${id}`,
	...overrides,
})

describe("the handshake", () => {
	it("sends nothing on open and arms a timer, so a gateway that never greets is noticed", () => {
		const step = gatewayProtocol.onOpen(ready(), NOW)
		expect(step.send).toBeUndefined()
		expect(step.state.heartbeatIntervalMs).toBeUndefined()
		expect(step.heartbeatAt).toBeGreaterThan(NOW)
	})

	it("identifies on HELLO when there is no session, asking for message content", () => {
		const step = gatewayProtocol.onFrame(
			state(),
			frame({ op: OP.hello, d: { heartbeat_interval: 41_250 } }),
			NOW,
			config,
		)
		const identify = sent(step.send?.[0])
		expect(identify.op).toBe(OP.identify)
		expect(identify.d).toMatchObject({ token: "bot-token", intents: INTENTS })
		// The privileged intent is required, not optional: without it every message the bot was not
		// mentioned in arrives empty and it can neither read a conversation nor answer a follow-up.
		expect(INTENTS & MESSAGE_CONTENT_INTENT).toBe(MESSAGE_CONTENT_INTENT)
		// And the two it has always had, which deliver GUILD_DELETE and MESSAGE_CREATE.
		expect(INTENTS & ((1 << 0) | (1 << 9))).toBe((1 << 0) | (1 << 9))
		expect(step.state.heartbeatIntervalMs).toBe(41_250)
		// The first heartbeat is jittered inside the interval, as Discord asks.
		expect(step.heartbeatAt).toBe(NOW + 20_625)
	})

	it("resumes on HELLO when a session is held", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			frame({ op: OP.hello, d: { heartbeat_interval: 41_250 } }),
			NOW,
			config,
		)
		const resume = sent(step.send?.[0])
		expect(resume.op).toBe(OP.resume)
		expect(resume.d).toEqual({ token: "bot-token", session_id: "session-1", seq: 7 })
	})

	it("identifies afresh over a session asked for with other intents, rather than resuming it", () => {
		// A RESUME keeps the intents of the IDENTIFY that made the session, however many deploys it
		// survives — so a session from before an intent was added would never receive it. `undefined`
		// is every session identified before the intents were recorded.
		for (const intents of [undefined, (1 << 0) | (1 << 9)]) {
			const held = ready({ intents })
			expect(gatewayProtocol.connectUrl(held, config)).toBe(
				"wss://gateway.discord.gg/?v=10&encoding=json",
			)
			const step = gatewayProtocol.onFrame(
				held,
				frame({ op: OP.hello, d: { heartbeat_interval: 41_250 } }),
				NOW,
				config,
			)
			const identify = sent(step.send?.[0])
			expect(identify.op).toBe(OP.identify)
			expect(identify.d).toMatchObject({ intents: INTENTS })
			expect(step.state.sessionId).toBeUndefined()
			expect(step.state.sequence).toBeUndefined()
		}
	})

	it("reconnects when HELLO does not decode", () => {
		const step = gatewayProtocol.onFrame(state(), frame({ op: OP.hello, d: {} }), NOW, config)
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
	})

	it("takes the session identity and the bot's own id from READY", () => {
		const step = gatewayProtocol.onFrame(
			state({ heartbeatIntervalMs: 41_250 }),
			dispatch("READY", {
				session_id: "session-2",
				resume_gateway_url: "wss://gateway-eu-west1-a.discord.gg",
				user: { id: "900000000000000001" },
			}),
			NOW,
			config,
		)
		expect(step.state.sessionId).toBe("session-2")
		expect(step.state.botUserId).toBe("900000000000000001")
		expect(step.state.intents).toBe(INTENTS)
		expect(gatewayProtocol.connectUrl(step.state, config)).toBe(
			"wss://gateway-eu-west1-a.discord.gg/?v=10&encoding=json",
		)
	})

	it("connects to the default gateway without a session", () => {
		expect(gatewayProtocol.connectUrl(state(), config)).toBe(
			"wss://gateway.discord.gg/?v=10&encoding=json",
		)
	})
})

describe("heartbeats", () => {
	it("sends the last sequence and opens an acknowledgement window", () => {
		const step = gatewayProtocol.heartbeat(ready(), NOW)
		expect(sent(step.send?.[0])).toEqual({ op: OP.heartbeat, d: 7 })
		expect(step.state.awaitingAck).toBe(true)
		expect(step.heartbeatAt).toBe(NOW + 41_250)
	})

	it("closes the window on HEARTBEAT_ACK", () => {
		const step = gatewayProtocol.onFrame(
			ready({ awaitingAck: true }),
			frame({ op: OP.heartbeatAck }),
			NOW,
			config,
		)
		expect(step.state.awaitingAck).toBe(false)
	})

	it("treats an unacknowledged heartbeat as a zombie connection and reconnects", () => {
		const step = gatewayProtocol.heartbeat(ready({ awaitingAck: true }), NOW)
		// Any code other than 1000/1001, which is what keeps the session resumable.
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
		expect(step.send).toBeUndefined()
	})

	it("reconnects when the timer fires before any HELLO arrived", () => {
		const step = gatewayProtocol.heartbeat(state(), NOW)
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
	})

	it("answers a server-initiated heartbeat immediately", () => {
		const step = gatewayProtocol.onFrame(ready(), frame({ op: OP.heartbeat }), NOW, config)
		expect(sent(step.send?.[0])).toEqual({ op: OP.heartbeat, d: 7 })
		expect(step.state.awaitingAck).toBe(true)
	})
})

describe("session lifecycle", () => {
	it("reconnects and keeps the session on the Reconnect opcode", () => {
		const step = gatewayProtocol.onFrame(ready(), frame({ op: OP.reconnect }), NOW, config)
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
		expect(step.state.sessionId).toBe("session-1")
	})

	it("keeps the session on a resumable Invalid Session", () => {
		const step = gatewayProtocol.onFrame(ready(), frame({ op: OP.invalidSession, d: true }), NOW, config)
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
		expect(step.state.sessionId).toBe("session-1")
	})

	it("forgets the session on a non-resumable Invalid Session, so the next connect identifies", () => {
		const step = gatewayProtocol.onFrame(ready(), frame({ op: OP.invalidSession, d: false }), NOW, config)
		expect(step.state.sessionId).toBeUndefined()
		expect(step.state.sequence).toBeUndefined()
		expect(gatewayProtocol.connectUrl(step.state, config)).toBe(
			"wss://gateway.discord.gg/?v=10&encoding=json",
		)
	})

	it("advances the sequence on every dispatch, including ones nothing is done with", () => {
		const step = gatewayProtocol.onFrame(ready(), dispatch("TYPING_START", {}, 11), NOW, config)
		expect(step.state.sequence).toBe(11)
		expect(step.events ?? []).toEqual([])
	})

	it("ignores an opcode it does not act on, keeping the sequence it carried", () => {
		const step = gatewayProtocol.onFrame(ready(), frame({ op: 8, s: 12 }), NOW, config)
		expect(step.directive).toBeUndefined()
		expect(step.send).toBeUndefined()
		expect(step.state.sequence).toBe(12)
	})

	it("reconnects on a clean close too, rather than leaving the bot off", () => {
		// 1000 is documented as non-reconnectable, but a bot that must stay up
		// treats a server-sent clean close as transient — the backoff is the host's.
		const step = gatewayProtocol.onClose(ready(), 1000, "")
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
		expect(step.state.sessionId).toBe("session-1")
	})

	it("drops a frame it cannot parse rather than closing a healthy connection", () => {
		const before = ready()
		const step = gatewayProtocol.onFrame(before, "not json", NOW, config)
		expect(step.state).toEqual(before)
		expect(step.directive).toBeUndefined()
	})
})

describe("close codes", () => {
	it.each([
		[4004, "a bad token"],
		[4010, "an invalid shard"],
		[4011, "sharding being required"],
		[4012, "an invalid API version"],
		[4013, "an invalid intent"],
		[4014, "a disallowed intent"],
	])("stops on %i (%s) instead of looping", (code) => {
		const step = gatewayProtocol.onClose(ready(), code, "")
		expect(step.directive?._tag).toBe("stop")
		// And only the intent code names the intent: 4004 is a bad token, and sending an operator to
		// the Bot tab over it is a wasted hour.
		if (code !== 4014) {
			expect(step.directive).toMatchObject({
				reason: expect.not.stringContaining("Message Content Intent"),
			})
		}
	})

	it("sends an operator to the portal on 4014, the one fatal code they can fix", () => {
		// The connector asks for exactly one privileged intent, so a disallowed one has exactly one
		// cause and one fix, and the line an operator reads should be that fix.
		const step = gatewayProtocol.onClose(ready(), 4014, "Disallowed intent(s).")
		expect(step.directive).toEqual({
			_tag: "stop",
			reason: expect.stringContaining("Message Content Intent"),
		})
		// And the session is kept rather than reconnected with: the loop stops here.
		expect(step.state).toEqual(ready())
	})

	it.each([
		[4001, "an unknown opcode"],
		[4002, "a decode error"],
		[4003, "not being authenticated"],
		[4005, "already being authenticated"],
	])("reconnects and keeps the session on %i (%s), which Discord marks reconnectable", (code) => {
		// These read like client bugs, and treating them as fatal would take the
		// bot down for hours over something the next connection fixes.
		const step = gatewayProtocol.onClose(ready(), code, "")
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
		expect(step.state.sessionId).toBe("session-1")
	})

	it("reconnects on an abnormal close and keeps the session", () => {
		const step = gatewayProtocol.onClose(ready(), 1006, "")
		expect(step.directive).toEqual({ _tag: "reconnect", closeCode: 4000 })
		expect(step.state.sessionId).toBe("session-1")
	})

	it.each([4007, 4009])("forgets the session on %i before reconnecting", (code) => {
		const step = gatewayProtocol.onClose(ready(), code, "")
		expect(step.directive?._tag).toBe("reconnect")
		expect(step.state.sessionId).toBeUndefined()
	})
})

describe("messages", () => {
	const message = (overrides: Record<string, unknown> = {}) =>
		dispatch("MESSAGE_CREATE", {
			id: "1000000000000000001",
			channel_id: "2000000000000000002",
			guild_id: "3000000000000000003",
			author: user("4000000000000000004", { global_name: "Ada" }),
			content: "<@900000000000000001> why is checkout slow?",
			mentions: [user("900000000000000001")],
			...overrides,
		})

	it("maps a mention to a message event with the bot's own mention removed", () => {
		const step = gatewayProtocol.onFrame(ready(), message(), NOW, config)
		expect(step.events).toEqual([
			{
				type: "message",
				connector: "discord",
				workspaceId: "3000000000000000003",
				channelId: "2000000000000000002",
				messageId: "1000000000000000001",
				author: { id: "4000000000000000004", displayName: "Ada", isBot: false },
				text: "why is checkout slow?",
				mentionsBot: true,
			},
		])
	})

	it("reads a payload carrying every field a real one does", () => {
		// The schemas name a fraction of a message object. Nothing may reject a
		// payload for the rest of it, which is the failure mode a hand-written
		// fixture never reproduces.
		const step = gatewayProtocol.onFrame(
			ready(),
			message({
				author: user("4000000000000000004", {
					avatar: null,
					discriminator: "0",
					public_flags: 0,
					avatar_decoration_data: null,
				}),
				mentions: [user("900000000000000001", { bot: true, member: { roles: [] } })],
				timestamp: "2026-09-20T09:00:00.000000+00:00",
				edited_timestamp: null,
				tts: false,
				attachments: [],
				embeds: [],
				pinned: false,
				mention_everyone: false,
				mention_roles: [],
				type: 0,
				flags: 0,
				nonce: "1000000000000000000",
				referenced_message: null,
			}),
			NOW,
			config,
		)
		expect(step.events?.[0]).toMatchObject({ mentionsBot: true })
	})

	it("prefers the server nickname as the display name", () => {
		const step = gatewayProtocol.onFrame(ready(), message({ member: { nick: "Ada L." } }), NOW, config)
		expect(step.events?.[0]).toMatchObject({ author: { displayName: "Ada L." } })
	})

	it("reports a message that mentions nobody, and says so", () => {
		// What a follow-up in a thread Maple opened looks like. Whether it is a TURN is the host's
		// decision, made against the conversation's session; the connector only reports it.
		const step = gatewayProtocol.onFrame(
			ready(),
			message({ content: "and the payments call?", mentions: [] }),
			NOW,
			config,
		)
		expect(step.events?.[0]).toMatchObject({ text: "and the payments call?", mentionsBot: false })
	})

	it("drops an unaddressed message with no text in it", () => {
		// An embed, an attachment, a system notice — and every message at all if the application
		// ever loses the content grant. There is no turn to start from nothing, and dropping it here
		// is one fewer host round trip per message.
		const step = gatewayProtocol.onFrame(ready(), message({ content: "", mentions: [] }), NOW, config)
		expect(step.events ?? []).toEqual([])
	})

	it("still reports a mention whose text is only the mention itself", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			message({ content: "<@900000000000000001>" }),
			NOW,
			config,
		)
		expect(step.events?.[0]).toMatchObject({ text: "", mentionsBot: true })
	})

	it("ignores another bot even when it mentioned nobody", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			message({ author: user("4000000000000000004", { bot: true }), content: "beep", mentions: [] }),
			NOW,
			config,
		)
		expect(step.events ?? []).toEqual([])
	})

	it("ignores another bot, so two deployments cannot talk to each other", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			message({ author: user("4000000000000000004", { bot: true }) }),
			NOW,
			config,
		)
		expect(step.events ?? []).toEqual([])
	})

	it("ignores a webhook post, which does not always carry the bot flag", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			message({ webhook_id: "5000000000000000005" }),
			NOW,
			config,
		)
		expect(step.events ?? []).toEqual([])
	})

	it("ignores a message outside a guild", () => {
		const step = gatewayProtocol.onFrame(ready(), message({ guild_id: undefined }), NOW, config)
		expect(step.events ?? []).toEqual([])
	})

	it("ignores messages before READY, when a mention cannot be recognised", () => {
		const step = gatewayProtocol.onFrame(ready({ botUserId: undefined }), message(), NOW, config)
		expect(step.events ?? []).toEqual([])
	})
})

describe("component clicks", () => {
	const interaction = (overrides: Record<string, unknown> = {}) =>
		dispatch("INTERACTION_CREATE", {
			id: "6000000000000000006",
			application_id: "7000000000000000007",
			token: "interaction-token",
			type: 3,
			guild_id: "3000000000000000003",
			channel_id: "2000000000000000002",
			message: { id: "1000000000000000001" },
			data: { custom_id: "approval:abc123", component_type: 2 },
			member: { user: user("4000000000000000004", { global_name: "Ada" }) },
			...overrides,
		})

	it("maps a click to an action event naming who clicked, and nothing about their powers", () => {
		const step = gatewayProtocol.onFrame(ready(), interaction(), NOW, config)
		expect(step.events).toEqual([
			{
				type: "action",
				connector: "discord",
				workspaceId: "3000000000000000003",
				channelId: "2000000000000000002",
				messageId: "1000000000000000001",
				actionToken: "approval:abc123",
				// An identity only: whether they may approve is whether they linked this account
				// to a Maple user, which Discord cannot answer and is never asked.
				actor: { id: "4000000000000000004", displayName: "Ada" },
				// The interaction's follow-up webhook, which is how only the clicker is answered.
				replyHandle: "7000000000000000007/interaction-token",
			},
		])
	})

	it("acknowledges within Discord's window with a deferred update", () => {
		const step = gatewayProtocol.onFrame(ready(), interaction(), NOW, config)
		expect(step.requests).toEqual([
			{
				method: "POST",
				url: "https://discord.com/api/v10/interactions/6000000000000000006/interaction-token/callback",
				headers: new Map([["content-type", "application/json"]]),
				body: JSON.stringify({ type: 6 }),
			},
		])
	})

	it("ignores an interaction that is not a component click", () => {
		const step = gatewayProtocol.onFrame(ready(), interaction({ type: 2 }), NOW, config)
		expect(step.events ?? []).toEqual([])
		expect(step.requests ?? []).toEqual([])
	})
})

describe("leaving a server", () => {
	it("reports a removal", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			dispatch("GUILD_DELETE", { id: "3000000000000000003" }),
			NOW,
			config,
		)
		expect(step.events).toEqual([
			{ type: "workspace-removed", connector: "discord", workspaceId: "3000000000000000003" },
		])
	})

	it("rides out an outage, which is the same dispatch with `unavailable`", () => {
		const step = gatewayProtocol.onFrame(
			ready(),
			dispatch("GUILD_DELETE", { id: "3000000000000000003", unavailable: true }),
			NOW,
			config,
		)
		expect(step.events ?? []).toEqual([])
	})
})

describe("state the host persists", () => {
	const ingress = socketIngress(gatewayProtocol)

	it("survives a round trip through the host's opaque string", () => {
		const opened = ingress.onOpen(ingress.initialState, NOW)
		const hello = ingress.onFrame(
			opened.state,
			frame({ op: OP.hello, d: { heartbeat_interval: 41_250 } }),
			NOW,
			config,
		)
		const beat = ingress.heartbeat(hello.state, NOW + 20_625)
		expect(sent(beat.send?.[0])).toEqual({ op: OP.heartbeat, d: null })
		expect(beat.heartbeatAt).toBe(NOW + 20_625 + 41_250)
	})

	it("falls back to a fresh state when the stored value no longer decodes", () => {
		const step = ingress.onOpen('{"awaitingAck":"yes"}', NOW)
		expect(sent(step.state)).toMatchObject({ awaitingAck: false })
	})
})
