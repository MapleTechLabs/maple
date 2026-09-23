/**
 * A relayed turn that outlives the object relaying it.
 *
 * Eviction here is what it is on the platform: the relaying fiber is dropped mid-turn and nothing
 * of it survives except what it wrote to storage. The resume then has to land on exactly what the
 * uninterrupted run would have left — the same messages, saying the same thing — without posting a
 * second copy of the answer into the conversation.
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
import { decodeRelayTurnCheckpoint, resumeRelayedTurn, type RelayTurnCheckpoint } from "./resume.ts"
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

/** A session whose every subscription is answered by `subscribe`. */
const session = (subscribe: ChatSessionStub["subscribe"]): ChatSessionStub => ({
	cursor: () => Promise.resolve(0),
	running: () => Promise.resolve(true),
	history: () => Promise.resolve([]),
	since: () => Promise.resolve([]),
	append: () => Promise.resolve(0),
	holdsTurn: () => Promise.resolve(false),
	endTurn: () => Promise.resolve(),
	abort: () => Promise.resolve(),
	settleProposal: () => Promise.resolve("unknown"),
	beginTurn: (input) => Promise.resolve({ cursor: 0, messageId: input.messageId, turnMessageId: "a1" }),
	subscribe,
})

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
const checkpointOf = (
	messages: ReadonlyArray<string>,
	overrides?: { readonly deadline?: number; readonly resumes?: number },
): RelayTurnCheckpoint =>
	readBack({
		checkpoint: {
			connector: TESTCHAT,
			sessionId: SESSION_ID,
			turnMessageId: "a1",
			cursor: 0,
			target,
			messages: messages.map((messageId) => ({ target, messageId })),
			deadline: overrides?.deadline ?? Number.MAX_SAFE_INTEGER,
			resumes: overrides?.resumes ?? 0,
		},
		writes: 0,
	})

/** The uninterrupted run: what each message should end up saying, in order. */
const uninterrupted = Effect.gen(function* () {
	const whole = platform()
	yield* relayInboundEvent(
		mention,
		ports(
			whole.outbound,
			session(() => Promise.resolve(sse(turn))),
			storage(),
		),
	)
	const posts = whole.calls.filter((call) => call.verb === "post").map((call) => call.ref.messageId)
	const settled = finalText(whole.calls)
	return { posts, settled: posts.map((messageId) => settled.get(messageId)) }
})

const recording = () => {
	const logs: Array<string> = []
	const spans: Array<Tracer.NativeSpan> = []
	const logger = Logger.make(({ fiber, message }) => {
		logs.push(JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }))
	})
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return {
		logs,
		spans,
		context: Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
			Context.add(Tracer.Tracer, tracer),
		),
	}
}

describe("resuming a relayed turn", () => {
	it.effect("finishes an evicted turn in the messages it had already posted", () =>
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
					ports(
						evicted.outbound,
						session(() => Promise.resolve(sse(turn.slice(0, 3), true))),
						stored,
						(checkpoint) =>
							checkpoint.messages.length > 1
								? Deferred.succeed(spread, undefined)
								: Effect.void,
					),
				),
			)
			while (!(yield* Deferred.isDone(spread))) yield* TestClock.adjust("10 millis")
			yield* Fiber.interrupt(fiber)
			const posted = evicted.calls.filter((call) => call.verb === "post").map((call) => call.ref)
			const before = evicted.calls.length

			const checkpoint = readBack(stored)
			expect(checkpoint.messages).toEqual(posted)
			yield* resumeRelayedTurn(
				checkpoint,
				ports(
					evicted.outbound,
					session(() => Promise.resolve(sse(turn))),
					stored,
				),
			)

			expect(evicted.calls.slice(before).map((call) => call.verb)).not.toContain("post")
			const settled = finalText(evicted.calls)
			expect(readBack(stored).messages.map((ref) => settled.get(ref.messageId))).toEqual(whole.settled)
			// The attempt is spent before the work, so a resume that is itself evicted counts.
			expect(readBack(stored).resumes).toBe(1)
		}),
	)

	it.effect("settles a turn that ended while nobody was relaying it, in one render", () =>
		Effect.gen(function* () {
			const whole = yield* uninterrupted
			const chat = platform()
			const stored = storage()

			yield* resumeRelayedTurn(
				checkpointOf(whole.posts),
				ports(
					chat.outbound,
					session(() => Promise.resolve(sse(turn))),
					stored,
				),
			)

			// One edit per message, nothing posted, and the checkpoint written once — for the attempt.
			expect(chat.calls.map((call) => `${call.verb} ${call.ref.messageId}`)).toEqual(
				whole.posts.map((messageId) => `edit ${messageId}`),
			)
			expect(chat.calls.map((call) => call.blocks)).toEqual(whole.settled)
			expect(stored.writes).toBe(1)
			expect(readBack(stored).resumes).toBe(1)
		}),
	)

	it.effect("posts only the messages the turn outgrew its checkpoint by", () =>
		Effect.gen(function* () {
			const whole = yield* uninterrupted
			expect(whole.posts.length).toBeGreaterThan(1)
			// Evicted after the first message was posted: the rest of the answer was never shown.
			const chat = platform("r")
			const stored = storage()

			yield* resumeRelayedTurn(
				checkpointOf(whole.posts.slice(0, 1)),
				ports(
					chat.outbound,
					session(() => Promise.resolve(sse(turn))),
					stored,
				),
			)

			const posted = chat.calls.filter((call) => call.verb === "post").map((call) => call.ref.messageId)
			expect(posted).toHaveLength(whole.posts.length - 1)
			const resumed = readBack(stored)
			expect(resumed.resumes).toBe(1)
			expect(resumed.messages.map((ref) => ref.messageId)).toEqual([whole.posts[0], ...posted])
			const settled = finalText(chat.calls)
			expect(resumed.messages.map((ref) => settled.get(ref.messageId))).toEqual(whole.settled)
		}),
	)

	it.effect("leaves the messages alone and logs once when the session is gone", () =>
		Effect.gen(function* () {
			const recorded = recording()
			const chat = platform()

			yield* resumeRelayedTurn(
				checkpointOf(["m1"]),
				ports(
					chat.outbound,
					session(() => Promise.reject(new Error(ANSWER))),
					storage(),
				),
			).pipe(Effect.provideContext(recorded.context))

			expect(recorded.logs).toHaveLength(1)
			expect(recorded.logs[0]).toContain("A relayed turn could not be resumed")
			// Nothing replayed, so nothing the reader already sees is overwritten.
			expect(chat.calls).toEqual([])
			// oxlint-disable-next-line effecttsgo/prefer-schema-over-json
			const everything = JSON.stringify({
				logs: recorded.logs,
				spans: recorded.spans.map((span) => ({
					attributes: Object.fromEntries(span.attributes),
					events: span.events,
				})),
			})
			expect(everything).not.toContain("checkout-service")
		}),
	)

	it.effect("stops at the turn's deadline, and says so once", () =>
		Effect.gen(function* () {
			const recorded = recording()
			const chat = platform()
			const fiber = yield* Effect.forkChild(
				resumeRelayedTurn(
					checkpointOf(["m1"], { deadline: Duration.toMillis(Duration.minutes(1)) }),
					ports(
						chat.outbound,
						// A turn the session never ends: the stream stays open.
						session(() => Promise.resolve(sse(turn.slice(0, 3), true))),
						storage(),
					),
				).pipe(Effect.provideContext(recorded.context)),
			)

			yield* TestClock.adjust("2 minutes")
			yield* Fiber.join(fiber)

			expect(recorded.logs).toHaveLength(1)
			expect(recorded.logs[0]).toContain("A relayed turn could not be resumed")
			expect(recorded.logs[0]).toContain("TimeoutError")
		}),
	)

	it.effect("gives up on a turn that has used its attempts, or its time", () =>
		Effect.gen(function* () {
			const chat = platform()
			const stored = storage()
			const subscribed: Array<number> = []
			const stub = session((cursor) => {
				subscribed.push(cursor)
				return Promise.resolve(sse(turn))
			})

			yield* resumeRelayedTurn(checkpointOf(["m1"], { resumes: 3 }), ports(chat.outbound, stub, stored))
			yield* resumeRelayedTurn(
				checkpointOf(["m1"], { deadline: 0 }),
				ports(chat.outbound, stub, stored),
			)

			expect(chat.calls).toEqual([])
			expect(subscribed).toEqual([])
			expect(stored.writes).toBe(0)
		}),
	)

	it("drops a checkpoint this build cannot read", () => {
		expect(decodeRelayTurnCheckpoint({ sessionId: SESSION_ID, messages: "m1" })).toEqual(Option.none())
	})
})
