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
import { Context, Duration, Effect, Fiber, Logger, Option, References, Schema, Tracer } from "effect"
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

const platform = (): Platform => {
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
						const ref = { target: postTarget, messageId: `m${++posted}` }
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
		Effect.sync(() => {
			stored.checkpoint = structuredClone(checkpoint)
			stored.writes += 1
		}),
})

/** What a fresh activation reads back — through the schema, as the object does. */
const readBack = (stored: ReturnType<typeof storage>): RelayTurnCheckpoint =>
	Option.getOrThrow(decodeRelayTurnCheckpoint(stored.checkpoint))

describe("resuming a relayed turn", () => {
	it.live("finishes an evicted turn in the messages it had already posted", () =>
		Effect.gen(function* () {
			// The uninterrupted run, for what the conversation should end up saying.
			const whole = platform()
			yield* relayInboundEvent(
				mention,
				ports(
					whole.outbound,
					session(() => Promise.resolve(sse(turn))),
					storage(),
				),
			)

			// The same turn, with its relay evicted after the answer's first delta: the connection is
			// still open, the turn is still running, and the fiber simply stops existing.
			const evicted = platform()
			const stored = storage()
			const fiber = yield* Effect.forkChild(
				relayInboundEvent(
					mention,
					ports(
						evicted.outbound,
						session(() => Promise.resolve(sse(turn.slice(0, 3), true))),
						stored,
					),
				),
			)
			yield* Effect.sleep("100 millis")
			yield* Fiber.interrupt(fiber)
			const posted = evicted.calls.filter((call) => call.verb === "post").map((call) => call.ref)
			expect(posted.length).toBeGreaterThan(1)
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

			const resumed = evicted.calls.slice(before)
			expect(resumed.map((call) => call.verb)).not.toContain("post")
			expect(finalText(evicted.calls)).toEqual(finalText(whole.calls))
			// The attempt is spent before the work, so a resume that is itself evicted counts.
			expect(readBack(stored).resumes).toBe(1)
		}),
	)

	it.effect("settles a turn that ended while nobody was relaying it, in one render", () =>
		Effect.gen(function* () {
			const chat = platform()
			const stored = storage()
			const checkpoint = readBack({
				checkpoint: {
					connector: TESTCHAT,
					sessionId: SESSION_ID,
					turnMessageId: "a1",
					cursor: 0,
					target,
					messages: [
						{ target, messageId: "m1" },
						{ target, messageId: "m2" },
						{ target, messageId: "m3" },
					],
					deadline: Number.MAX_SAFE_INTEGER,
					resumes: 0,
				},
				writes: 0,
			})

			yield* resumeRelayedTurn(
				checkpoint,
				ports(
					chat.outbound,
					session(() => Promise.resolve(sse(turn))),
					stored,
				),
			)

			expect(chat.calls.map((call) => `${call.verb} ${call.ref.messageId}`)).toEqual([
				"edit m1",
				"edit m2",
				"edit m3",
			])
		}),
	)

	it.effect("logs a session that is gone once, without the conversation in it", () =>
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
			const checkpoint = readBack({
				checkpoint: {
					connector: TESTCHAT,
					sessionId: SESSION_ID,
					turnMessageId: "a1",
					cursor: 0,
					target,
					messages: [{ target, messageId: "m1" }],
					deadline: Number.MAX_SAFE_INTEGER,
					resumes: 0,
				},
				writes: 0,
			})

			yield* resumeRelayedTurn(
				checkpoint,
				ports(
					chat.outbound,
					session(() => Promise.reject(new Error(ANSWER))),
					storage(),
				),
			).pipe(
				Effect.provideContext(
					Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
						Context.add(Tracer.Tracer, tracer),
					),
				),
			)

			expect(logs).toHaveLength(1)
			expect(logs[0]).toContain("A relayed turn could not be resumed")
			// Settled on the notice rather than left mid-answer, and never posted again.
			expect(chat.calls.map((call) => call.verb)).toEqual(["edit"])
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

	it.effect("gives up on a turn that has used its attempts, or its time", () =>
		Effect.gen(function* () {
			const chat = platform()
			const stored = storage()
			const subscribed: Array<number> = []
			const stub = session((cursor) => {
				subscribed.push(cursor)
				return Promise.resolve(sse(turn))
			})
			const base = {
				connector: TESTCHAT,
				sessionId: SESSION_ID,
				turnMessageId: "a1",
				cursor: 0,
				target,
				messages: [{ target, messageId: "m1" }],
			}

			yield* resumeRelayedTurn(
				readBack({
					checkpoint: { ...base, deadline: Number.MAX_SAFE_INTEGER, resumes: 3 },
					writes: 0,
				}),
				ports(chat.outbound, stub, stored),
			)
			yield* resumeRelayedTurn(
				readBack({ checkpoint: { ...base, deadline: 0, resumes: 0 }, writes: 0 }),
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
