/**
 * A relayed turn that outlives the object relaying it.
 *
 * Eviction here is what it is on the platform: the relaying fiber is dropped mid-turn and nothing
 * of it survives except what it wrote to storage. Once the session has ended the turn, the settle
 * has to land on exactly what the uninterrupted run would have left — the same messages, saying the
 * same thing — without posting a second copy of the answer into the conversation.
 */
import { describe, expect, it } from "@effect/vitest"
import {
	chatConnectorId,
	type ChatBlock,
	type ChatMessageRef,
	type ChatOutbound,
	type InboundMessage,
} from "@maple/chat-platform"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEvent,
	type ChatEventInput,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { OrgId } from "@maple/domain/primitives"
import {
	Context,
	Deferred,
	Duration,
	Effect,
	Fiber,
	Logger,
	Option,
	References,
	Schema,
	Tracer,
} from "effect"
import { TestClock } from "effect/testing"
import { decodeRelayTurnCheckpoint, settleRelayedTurn, type RelayTurnCheckpoint } from "./settle.ts"
import { relayInboundEvent, type RelayPorts } from "./turn.ts"

const TESTCHAT = chatConnectorId("testchat")
const ORG = Schema.decodeSync(OrgId)("org_1")
const CONVERSATION = "conversation1"
const SESSION_ID = `${ORG}:bot-${TESTCHAT}-${CONVERSATION}`
const target = { workspaceId: "workspace-1", channelId: CONVERSATION }

const mention: InboundMessage = {
	type: "message",
	connector: TESTCHAT,
	workspaceId: "workspace-1",
	channelId: "channel-1",
	messageId: "message-1",
	author: { id: "author-1", displayName: "Ada", isBot: false },
	text: "why is checkout slow?",
	mentionsBot: true,
}

const event = (seq: number, input: ChatEventInput): ChatEvent =>
	decodeChatEventPayload(encodeChatEventPayload(input), seq)

/** Long enough that the 80-character budget below cuts the answer into several messages. */
const ANSWER = "The checkout-service p99 doubled after the 14:02 deploy.\n".repeat(3)

const turn: ReadonlyArray<ChatEvent> = [
	event(1, { type: "user-message", id: "u1", text: mention.text }),
	event(2, { type: "turn-start", messageId: "a1" }),
	event(3, { type: "text-delta", messageId: "a1", text: ANSWER }),
	event(4, { type: "text-delta", messageId: "a1", text: "Roll it back." }),
	event(5, { type: "turn-end", messageId: "a1", reason: "stop" }),
]

/** SSE frames, as the session writes them. `open` leaves the connection up, as a live turn does. */
const sse = (events: ReadonlyArray<ChatEvent>, open = false): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			const frames = events.map((next) => `id: ${next.seq}\ndata: ${JSON.stringify(next)}\n\n`)
			controller.enqueue(new TextEncoder().encode(`retry: 1000\n\n${frames.join("")}`))
			if (!open) controller.close()
		},
	})

interface Platform {
	readonly outbound: ChatOutbound
	readonly calls: Array<{ verb: "post" | "edit"; ref: ChatMessageRef; blocks: ReadonlyArray<ChatBlock> }>
}

/** `prefix` names the messages this platform posts, so two platforms' messages never collide. */
const platform = (prefix = "m"): Platform => {
	const calls: Platform["calls"] = []
	let posted = 0
	return {
		calls,
		outbound: {
			connectorId: TESTCHAT,
			limits: { maxMessageChars: 80, minEditInterval: Duration.millis(10) },
			transport: Effect.sync(() => ({
				post: (postTarget, blocks) =>
					Effect.sync(() => {
						const ref = { target: postTarget, messageId: `${prefix}${++posted}` }
						calls.push({ verb: "post", ref, blocks })
						return ref
					}),
				edit: (ref, blocks) => Effect.sync(() => void calls.push({ verb: "edit", ref, blocks })),
				typing: () => Effect.void,
				openThread: (request) => Effect.succeed(request.anchorMessageId),
				conversation: () =>
					Effect.succeed({
						conversationKey: Schema.decodeSync(
							Schema.String.pipe(Schema.brand("@maple/ChatConversationKey")),
						)(CONVERSATION),
						target,
						opened: false,
					}),
				history: () => Effect.succeed([]),
			})),
		},
	}
}

/** What each message says last — the conversation as a reader would find it. */
const finalText = (calls: Platform["calls"]): Map<string, ReadonlyArray<ChatBlock>> =>
	new Map(calls.map((call) => [call.ref.messageId, call.blocks]))

/**
 * A session that has run `turn`, or is still running it (`running`: its log stops mid-answer).
 * `open` keeps a subscription up, as a live turn does; `gone` fails every read; `empty` is a fresh
 * object that never ran anything.
 */
const session = (options?: {
	readonly open?: boolean
	readonly running?: boolean
	readonly gone?: boolean
	readonly empty?: boolean
}): ChatSessionStub => {
	const log = options?.empty === true ? [] : options?.running === true ? turn.slice(0, 3) : turn
	return {
		cursor: () => Promise.resolve(0),
		running: () =>
			options?.gone === true
				? Promise.reject(new Error(ANSWER))
				: Promise.resolve(options?.running ?? false),
		history: () => Promise.resolve([]),
		since: (cursor) =>
			options?.gone === true
				? Promise.reject(new Error(ANSWER))
				: Promise.resolve(log.filter((next) => next.seq > cursor)),
		append: () => Promise.resolve(0),
		holdsTurn: () => Promise.resolve(false),
		endTurn: () => Promise.resolve(),
		abort: () => Promise.resolve(),
		settleProposal: () => Promise.resolve("unknown"),
		beginTurn: (input) => Promise.resolve({ cursor: 0, messageId: input.messageId, turnMessageId: "a1" }),
		subscribe: () => Promise.resolve(options?.open === true ? sse(turn.slice(0, 3), true) : sse(turn)),
	}
}

/** The relay object's storage, reduced to the one key a turn's checkpoint lives under. */
const storage = () => ({ checkpoint: undefined as unknown, writes: 0 })

const ports = (
	outbound: ChatOutbound,
	stub: ChatSessionStub,
	stored: ReturnType<typeof storage>,
	onRecord: (checkpoint: RelayTurnCheckpoint) => Effect.Effect<void> = () => Effect.void,
): RelayPorts => ({
	outbound,
	supportsIdentity: false,
	resolveWorkspace: () => Effect.succeed(Option.some({ orgId: ORG })),
	forgetWorkspace: () => Effect.void,
	chatSession: () => stub,
	appBaseUrl: "https://app.maple.dev",
	chartImageUrl: () => null,
	announceUnlinked: Effect.succeed(false),
	ownsConversation: () => Effect.succeed(false),
	rememberConversation: () => Effect.void,
	// Cloned, as Durable Object storage does: nothing the fiber holds survives it.
	recordTurn: (checkpoint) =>
		Effect.suspend(() => {
			stored.checkpoint = structuredClone(checkpoint)
			stored.writes += 1
			return onRecord(checkpoint)
		}),
})

/** What a fresh activation reads back — through the schema, as the object does. */
const readBack = (stored: ReturnType<typeof storage>): RelayTurnCheckpoint =>
	Option.getOrThrow(decodeRelayTurnCheckpoint(stored.checkpoint))

/** A checkpoint as an earlier activation left it, holding `messages`. */
const checkpointOf = (messages: ReadonlyArray<string>, recordedAt = 0): RelayTurnCheckpoint =>
	readBack({
		checkpoint: {
			connector: TESTCHAT,
			sessionId: SESSION_ID,
			turnMessageId: "a1",
			cursor: 0,
			target,
			messages: messages.map((messageId) => ({ target, messageId })),
			recordedAt,
		},
		writes: 0,
	})

/** The uninterrupted run: what each message should end up saying, in order. */
const uninterrupted = Effect.gen(function* () {
	const whole = platform()
	yield* relayInboundEvent(mention, ports(whole.outbound, session(), storage()))
	const posts = whole.calls.filter((call) => call.verb === "post").map((call) => call.ref.messageId)
	const settled = finalText(whole.calls)
	return { posts, settled: posts.map((messageId) => settled.get(messageId)) }
})

describe("settling a relayed turn", () => {
	it.effect("lands the final answer in the messages an evicted relay had posted", () =>
		Effect.gen(function* () {
			const whole = yield* uninterrupted

			// The same turn, with its relay evicted once the answer has spread over several messages:
			// the connection is still open, the turn is still running, and the fiber stops existing.
			const evicted = platform()
			const stored = storage()
			const spread = yield* Deferred.make<void>()
			const fiber = yield* Effect.forkChild(
				relayInboundEvent(
					mention,
					ports(evicted.outbound, session({ open: true }), stored, (checkpoint) =>
						checkpoint.messages.length > 1 ? Deferred.succeed(spread, undefined) : Effect.void,
					),
				),
			)
			while (!(yield* Deferred.isDone(spread))) yield* TestClock.adjust("10 millis")
			yield* Fiber.interrupt(fiber)
			const before = evicted.calls.length
			const checkpoint = readBack(stored)
			expect(checkpoint.messages).toEqual(
				evicted.calls.filter((call) => call.verb === "post").map((call) => call.ref),
			)

			// While the session is still running the turn, a tick leaves everything alone.
			const early = yield* settleRelayedTurn(
				checkpoint,
				ports(evicted.outbound, session({ running: true }), stored),
			)
			expect(early).toBe("pending")
			expect(evicted.calls).toHaveLength(before)

			// Once it has ended: one render, into the same messages, and nothing posted twice.
			const late = yield* settleRelayedTurn(checkpoint, ports(evicted.outbound, session(), stored))
			expect(late).toBe("done")
			const settled = evicted.calls.slice(before)
			expect(settled.map((call) => call.verb)).not.toContain("post")
			expect(settled).toHaveLength(checkpoint.messages.length)
			const last = finalText(evicted.calls)
			expect(checkpoint.messages.map((ref) => last.get(ref.messageId))).toEqual(whole.settled)
		}),
	)

	it.effect("posts the part of the answer an evicted relay never reached", () =>
		Effect.gen(function* () {
			const whole = yield* uninterrupted
			const chat = platform("r")
			const stored = storage()

			yield* settleRelayedTurn(
				checkpointOf(whole.posts.slice(0, 1)),
				ports(chat.outbound, session(), stored),
			)

			const posted = chat.calls.filter((call) => call.verb === "post").map((call) => call.ref.messageId)
			expect(posted).toHaveLength(whole.posts.length - 1)
			// Recorded as it goes, so a settle that is itself evicted does not post it again.
			const messages = readBack(stored).messages.map((ref) => ref.messageId)
			expect(messages).toEqual([whole.posts[0], ...posted])
			const last = finalText(chat.calls)
			expect(messages.map((messageId) => last.get(messageId))).toEqual(whole.settled)
		}),
	)

	it.effect("drops a turn whose session is gone, and says so once without the conversation", () =>
		Effect.gen(function* () {
			const logs: Array<string> = []
			const spans: Array<Tracer.NativeSpan> = []
			const logger = Logger.make(({ fiber, message }) => {
				logs.push(
					JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }),
				)
			})
			const tracer = Tracer.make({
				span(options) {
					const span = new Tracer.NativeSpan(options)
					spans.push(span)
					return span
				},
			})
			const chat = platform()

			const outcome = yield* settleRelayedTurn(
				checkpointOf(["m1"]),
				ports(chat.outbound, session({ gone: true }), storage()),
			).pipe(
				Effect.provideContext(
					Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
						Context.add(Tracer.Tracer, tracer),
					),
				),
			)

			expect(outcome).toBe("done")
			expect(chat.calls).toEqual([])
			expect(logs).toHaveLength(1)
			expect(logs[0]).toContain("A relayed turn could not be settled")
			// oxlint-disable-next-line effecttsgo/prefer-schema-over-json
			const everything = JSON.stringify({
				logs,
				spans: spans.map((span) => ({
					attributes: Object.fromEntries(span.attributes),
					events: span.events,
				})),
			})
			expect(everything).not.toContain("checkout-service")
		}),
	)

	it.effect("drops a turn whose session has nothing to settle it from, and says so once", () =>
		Effect.gen(function* () {
			const chat = platform()
			const logs: Array<string> = []
			const logger = Logger.make(({ message }) => void logs.push(String(message)))

			const outcome = yield* settleRelayedTurn(
				checkpointOf(["m1"]),
				ports(chat.outbound, session({ empty: true }), storage()),
			).pipe(Effect.provideContext(Context.make(Logger.CurrentLoggers, new Set([logger]))))

			expect(outcome).toBe("done")
			expect(chat.calls).toEqual([])
			expect(logs).toHaveLength(1)
		}),
	)

	it.effect("drops a checkpoint older than any turn the session would still be running", () =>
		Effect.gen(function* () {
			const chat = platform()
			yield* TestClock.adjust("31 minutes")

			const outcome = yield* settleRelayedTurn(
				checkpointOf(["m1"]),
				ports(chat.outbound, session({ running: true }), storage()),
			)

			expect(outcome).toBe("done")
			expect(chat.calls).toEqual([])
		}),
	)

	it("drops a checkpoint this build cannot read", () => {
		expect(decodeRelayTurnCheckpoint({ sessionId: SESSION_ID, messages: "m1" })).toEqual(Option.none())
	})
})
