/**
 * The relay object's one durable fact: which conversations the bot opened itself.
 *
 * Worth its own test because the two things that can go wrong here are invisible in review. The
 * marker is keyed by CONVERSATION, not held as a flag on the object, or the first thread the bot
 * opens in a channel would speak for every thread in it on a platform that addresses threads inside
 * their channel. And it is written to the object that will handle the conversation's LATER
 * messages, which is not the object handling the message that opened it — locally when they are the
 * same object, because a Durable Object calling itself deadlocks behind its own input gate.
 */
import type { ChatConversation, InboundMessage } from "@maple/chat-platform"
import { chatConnectorId } from "@maple/chat-platform"
import { ChatConversationKey } from "@maple/domain/chat-session"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ConnectorRelay } from "./ConnectorRelay.ts"

const TESTCHAT = chatConnectorId("testchat")
const conversationKey = Schema.decodeSync(ChatConversationKey)

const message: InboundMessage = {
	type: "message",
	connector: TESTCHAT,
	workspaceId: "workspace-1",
	channelId: "channel-1",
	messageId: "message-1",
	author: { id: "author-1", displayName: "Ada", isBot: false },
	text: "why is checkout slow?",
	mentionsBot: true,
}

/** A conversation the connector opened for that message, at whatever address it gave it. */
const conversation = (channelId: string, key = channelId): ChatConversation => ({
	conversationKey: conversationKey(key),
	target: { workspaceId: message.workspaceId, channelId },
	opened: true,
})

/** One object's storage, and the alarm it arms — enough of the platform to drive the class. */
const objectState = () => {
	const stored = new Map<string, unknown>()
	return {
		stored,
		waitUntil: () => undefined,
		storage: {
			setAlarm: () => Promise.resolve(),
			get: <A>(key: string) => Promise.resolve(stored.get(key) as A | undefined),
			put: (key: string, value: boolean) => {
				stored.set(key, value)
				return Promise.resolve()
			},
		},
	}
}

/**
 * A deployment of relay objects, addressed the way the Worker env addresses them.
 *
 * `ports` is what the object hands the turn — the same two Effects `RelayPorts` declares — so a
 * test drives the real routing rather than a description of it.
 */
const deployment = () => {
	const objects = new Map<string, ReturnType<typeof objectState>>()
	const env: Record<string, unknown> = {}
	const relays = new Map<string, ConnectorRelay>()
	const at = (name: string) => {
		const existing = relays.get(name)
		if (existing !== undefined) return existing
		const state = objectState()
		objects.set(name, state)
		const relay = new ConnectorRelay(state, env)
		relays.set(name, relay)
		return relay
	}
	env.ConnectorRelay = {
		idFromName: (name: string) => name,
		get: (name: unknown) => at(String(name)),
	}
	return {
		objects,
		/** The ports the object handling `event` builds for the turn it runs. */
		ports: (name: string, event: InboundMessage) => at(name).relayPorts(event),
	}
}

describe("remembering the conversations the bot opened", () => {
	it("records a thread the platform gave its own address on the object that will answer in it", () =>
		Effect.gen(function* () {
			const fleet = deployment()
			// The mention arrived in the channel, and the connector opened `thread_7` for it.
			const ports = fleet.ports("testchat:workspace-1:channel-1", message)

			yield* ports.rememberConversation(conversation("thread_7"))

			// Not on the channel's object, where nothing will ever ask about it…
			expect([...(fleet.objects.get("testchat:workspace-1:channel-1")?.stored ?? [])]).toEqual([])
			// …but on the thread's, which is where the follow-up will arrive.
			expect([...(fleet.objects.get("testchat:workspace-1:thread_7")?.stored ?? [])]).toEqual([
				["opened:thread_7", true],
			])
		}).pipe(Effect.runPromise))

	it("answers for the conversation that was recorded, and only that one", () =>
		Effect.gen(function* () {
			const fleet = deployment()
			const name = "testchat:workspace-1:channel-1"
			// A platform that puts a thread INSIDE a channel: both conversations are this object's,
			// so a flag rather than a key would make the first one speak for the second.
			const here = { ...message, channelId: "channel-1" }
			const ports = fleet.ports(name, here)

			yield* ports.rememberConversation({
				conversationKey: conversationKey("thread_a"),
				target: { workspaceId: "workspace-1", channelId: "channel-1", threadId: "thread_a" },
				opened: true,
			})

			expect(yield* ports.ownsConversation(conversationKey("thread_a"))).toBe(true)
			expect(yield* ports.ownsConversation(conversationKey("thread_b"))).toBe(false)
		}).pipe(Effect.runPromise))

	it("reports a write that did not land, rather than losing it to a console", () =>
		Effect.gen(function* () {
			// The turn logs this and answers anyway. It is still the one failure that makes a bot
			// answer mentions here and nothing else, so it has to reach the turn to be logged there.
			const broken = objectState()
			broken.storage.put = () => Promise.reject(new Error("storage unavailable"))
			const relay = new ConnectorRelay(broken, {})
			const here = { ...message, channelId: "channel-1" }

			const error = yield* Effect.flip(
				relay.relayPorts(here).rememberConversation(conversation("channel-1", "thread_a")),
			)

			expect(error._tag).toBe("@maple/chat-bot/ConversationNotRecorded")
			expect(error.conversationKey).toBe("thread_a")
		}).pipe(Effect.runPromise))

	it("survives a deployment that binds no relay namespace at all", () =>
		Effect.gen(function* () {
			// Nothing to write to, and the turn this rides on is somebody's question: the answer must
			// still be given, at the cost of the follow-ups after it.
			const relay = new ConnectorRelay(objectState(), {})
			const ports = relay.relayPorts(message)

			yield* ports.rememberConversation(conversation("thread_7"))

			expect(yield* ports.ownsConversation(conversationKey("thread_7"))).toBe(false)
		}).pipe(Effect.runPromise))
})
