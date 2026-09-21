/**
 * A mention, all the way to an answer in the conversation — against a connector that is nobody's
 * platform and a chat session that is a script.
 *
 * This is the test the feature is bought with: no Durable Object, no database, no chat platform,
 * and every branch a reader can actually observe — the turn, the busy reply, the workspace nobody
 * linked, a session that recycles its connection mid-turn, a turn that fails, and the picture a
 * chart is relayed as.
 */
import { describe, expect, it } from "@effect/vitest"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEvent,
	type ChatEventInput,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { ChatConnectorId, OrgId } from "@maple/domain/primitives"
import {
	chatConnectorId,
	ChatOutboundError,
	type ChatBlock,
	type ChatChartRef,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatTarget,
	type InboundAction,
	type InboundMessage,
	type InboundWorkspaceRemoved,
} from "@maple/chat-platform"
import { Context, Duration, Effect, Logger, Option, References, Schema, Tracer } from "effect"
import { relayInboundEvent, WorkspaceLookupFailed, type RelayPorts } from "./turn.ts"

const TESTCHAT = chatConnectorId("testchat")
const ORG = Schema.decodeSync(OrgId)("org_1")
const WORKSPACE = "workspace-1"
const CHANNEL = "channel-1"
/** What the fake connector opens for a mention — a thread, as a real one would. */
const CONVERSATION = "conversation1"
const SESSION_ID = `${ORG}:bot-${TESTCHAT}-${CONVERSATION}`

const mention: InboundMessage = {
	type: "message",
	connector: TESTCHAT,
	workspaceId: WORKSPACE,
	channelId: CHANNEL,
	messageId: "message-1",
	author: { id: "author-1", displayName: "Ada", isBot: false },
	text: "why is checkout slow?",
	mentionsBot: true,
}

// ── The platform ─────────────────────────────────────────────────────────────

interface Chat {
	readonly outbound: ChatOutbound
	/** Every post and edit, in order. */
	readonly calls: Array<{ verb: "post" | "edit"; ref: ChatMessageRef; blocks: ReadonlyArray<ChatBlock> }>
	readonly threads: Array<string>
}

const chat = (): Chat => {
	const calls: Chat["calls"] = []
	const threads: Array<string> = []
	let posted = 0
	return {
		calls,
		threads,
		outbound: {
			connectorId: TESTCHAT,
			limits: { maxMessageChars: 2000, minEditInterval: Duration.millis(10) },
			transport: Effect.sync(() => ({
				post: (target, blocks) =>
					Effect.sync(() => {
						const ref = { target, messageId: `m${++posted}` }
						calls.push({ verb: "post", ref, blocks })
						return ref
					}),
				edit: (ref, blocks) => Effect.sync(() => void calls.push({ verb: "edit", ref, blocks })),
				typing: () => Effect.void,
				openThread: (request) => Effect.succeed(request.anchorMessageId),
				conversation: (message) =>
					Effect.sync(() => {
						threads.push(message.messageId)
						return {
							conversationKey: Schema.decodeSync(
								Schema.String.pipe(Schema.brand("@maple/ChatConversationKey")),
							)(CONVERSATION),
							target: { workspaceId: message.workspaceId, channelId: CONVERSATION },
						}
					}),
			})),
		},
	}
}

// ── The chat session ─────────────────────────────────────────────────────────

/** Through the real codec, so the frames on the wire are the ones the session would write. */
const event = (seq: number, input: ChatEventInput): ChatEvent =>
	decodeChatEventPayload(encodeChatEventPayload(input), seq)

/** What the session writes: one SSE frame per event, behind the `retry:` hint it opens with. */
const sse = (events: ReadonlyArray<ChatEvent>): ReadableStream<Uint8Array> => {
	const payload =
		"retry: 1000\n\n" +
		events.map((next) => `id: ${next.seq}\ndata: ${JSON.stringify(next)}\n\n`).join("")
	const bytes = new TextEncoder().encode(payload)
	// Cut mid-frame, so the decoder's buffer is exercised rather than assumed.
	const cut = Math.floor(bytes.length / 2)
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, cut))
			controller.enqueue(bytes.slice(cut))
			controller.close()
		},
	})
}

type BeginTurnInput = Parameters<ChatSessionStub["beginTurn"]>[0]

interface Session {
	readonly stub: ChatSessionStub
	readonly turns: Array<BeginTurnInput>
	readonly cursors: Array<number>
}

/**
 * A session that answers with one scripted connection per subscription.
 *
 * `busy` is what the Durable Object answers when a turn is already in flight: the claim, not an
 * error.
 */
const session = (
	connections: ReadonlyArray<ReadonlyArray<ChatEvent>>,
	options?: { readonly busy?: boolean },
): Session => {
	const turns: Array<BeginTurnInput> = []
	const cursors: Array<number> = []
	let opened = 0
	return {
		turns,
		cursors,
		stub: {
			cursor: () => Promise.resolve(0),
			running: () => Promise.resolve(false),
			history: () => Promise.resolve([]),
			since: () => Promise.resolve([]),
			append: () => Promise.resolve(0),
			holdsTurn: () => Promise.resolve(false),
			endTurn: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			beginTurn: (input) => {
				turns.push(input)
				return Promise.resolve(
					options?.busy === true
						? undefined
						: { cursor: 0, messageId: input.messageId, turnMessageId: "a1" },
				)
			},
			subscribe: (cursor) => {
				cursors.push(cursor)
				return Promise.resolve(sse(connections[Math.min(opened++, connections.length - 1)] ?? []))
			},
		},
	}
}

// ── The host ─────────────────────────────────────────────────────────────────

interface Host {
	readonly ports: RelayPorts
	readonly forgotten: Array<string>
	readonly charts: Array<{ orgId: OrgId; ref: ChatChartRef }>
}

const host = (
	outbound: ChatOutbound,
	stub: ChatSessionStub | undefined,
	options?: {
		readonly linked?: boolean
		readonly announceUnlinked?: boolean
		/** The database could not answer, which is not the same as nobody having linked it. */
		readonly lookupFails?: boolean
	},
): Host => {
	const forgotten: Array<string> = []
	const charts: Array<{ orgId: OrgId; ref: ChatChartRef }> = []
	return {
		forgotten,
		charts,
		ports: {
			outbound,
			resolveWorkspace: (connector) =>
				options?.lookupFails === true
					? Effect.fail(
							new WorkspaceLookupFailed({ connector, message: "the database said nothing" }),
						)
					: Effect.succeed(options?.linked === false ? Option.none() : Option.some({ orgId: ORG })),
			forgetWorkspace: (_connector: ChatConnectorId, workspaceId: string) =>
				Effect.sync(() => void forgotten.push(workspaceId)),
			chatSession: () => stub,
			appBaseUrl: "https://app.maple.dev",
			chartImageUrl: (orgId, ref) => {
				charts.push({ orgId, ref })
				return `https://app.maple.dev/chat/chart/${ref.chartIndex}.png`
			},
			announceUnlinked: Effect.succeed(options?.announceUnlinked ?? true),
		},
	}
}

const CHART_FENCE = '```chart\n{"type":"ranked","unit":"count","data":[{"name":"checkout","value":3}]}\n```'

const blocksOf = (calls: Chat["calls"]): ReadonlyArray<ChatBlock> => calls[calls.length - 1]?.blocks ?? []

const prose = (blocks: ReadonlyArray<ChatBlock>): string =>
	blocks
		.filter((block) => block.kind === "prose")
		.map((block) => block.markdown)
		.join("\n")

const notices = (blocks: ReadonlyArray<ChatBlock>): ReadonlyArray<string> =>
	blocks.flatMap((block) => (block.kind === "notice" ? [block.text] : []))

const target: ChatTarget = { workspaceId: WORKSPACE, channelId: CONVERSATION }

describe("relaying a mention", () => {
	it.effect("claims a turn for the conversation and streams the answer into it", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([
				[
					event(1, { type: "user-message", id: "u1", text: "why is checkout slow?" }),
					event(2, { type: "turn-start", messageId: "a1" }),
					event(3, { type: "text-delta", messageId: "a1", text: "Checkout is slow." }),
					event(4, { type: "turn-end", messageId: "a1", reason: "stop" }),
				],
			])
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			// One turn, on the session the connector's conversation key names.
			expect(agent.turns).toHaveLength(1)
			const turn = agent.turns[0]!
			expect(turn.sessionId).toBe(SESSION_ID)
			// The org's own tenant, with no roles: a connector turn proposes mutations, it does not
			// perform them.
			expect(turn.tenant).toMatchObject({ orgId: ORG, roles: [] })
			// The agreed single protection: a `bot-` session is only ever driven with this origin.
			expect(turn.origin).toEqual({
				kind: "connector",
				connectorId: TESTCHAT,
				workspaceId: WORKSPACE,
				externalUserId: "author-1",
				displayName: "Ada",
			})
			// Who is speaking travels as fenced context, ahead of what they actually asked.
			expect(turn.text).toContain("Ada")
			expect(turn.text).toContain("why is checkout slow?")

			// A placeholder first, then the answer, in the conversation the connector opened.
			expect(platform.calls[0]?.verb).toBe("post")
			expect(platform.calls[0]?.ref.target).toEqual(target)
			expect(platform.calls.map((call) => call.verb)).toContain("edit")
			expect(prose(blocksOf(platform.calls))).toBe("Checkout is slow.")
			expect(platform.threads).toEqual(["message-1"])
		}),
	)

	it.effect("keeps reading across a connection the session recycled mid-turn", () =>
		Effect.gen(function* () {
			const platform = chat()
			// What a turn that spends more than the idle window thinking looks like: the first
			// connection ends without a `turn-end`, and the answer arrives on the next one.
			const agent = session([
				[
					event(1, { type: "turn-start", messageId: "a1" }),
					event(2, { type: "text-delta", messageId: "a1", text: "Looking" }),
				],
				[
					event(3, { type: "text-delta", messageId: "a1", text: " into it." }),
					event(4, { type: "turn-end", messageId: "a1", reason: "stop" }),
				],
			])
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			// The second subscription resumes from the last seq seen, so nothing is read twice and
			// nothing is missed.
			expect(agent.cursors).toEqual([0, 2])
			expect(prose(blocksOf(platform.calls))).toBe("Looking into it.")
		}),
	)

	it.effect("says how a turn that did not finish ended", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([
				[
					event(1, { type: "turn-start", messageId: "a1" }),
					event(2, { type: "turn-end", messageId: "a1", reason: "max-steps" }),
				],
			])
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			expect(notices(blocksOf(platform.calls))).toEqual([
				"Stopped at the step limit — a narrower question will get further.",
			])
		}),
	)

	it.effect("relays a chart the agent drew as the picture this deployment can sign", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([
				[
					event(1, { type: "turn-start", messageId: "a1" }),
					event(2, { type: "text-delta", messageId: "a1", text: CHART_FENCE }),
					event(3, { type: "turn-end", messageId: "a1", reason: "stop" }),
				],
			])
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			const chart = blocksOf(platform.calls).find((block) => block.kind === "chart")
			expect(chart?.imageUrl).toBe("https://app.maple.dev/chat/chart/0.png")
			// Signed for the org that owns the conversation, naming the reply it is a fence inside.
			expect(deployment.charts[0]?.orgId).toBe(ORG)
			expect(deployment.charts[0]?.ref).toMatchObject({ sessionId: SESSION_ID, chartIndex: 0 })
		}),
	)

	it.effect("answers a second question in a busy conversation without queueing it", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([], { busy: true })
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			expect(agent.cursors).toEqual([])
			expect(platform.calls).toHaveLength(1)
			expect(notices(blocksOf(platform.calls))).toEqual([
				"Still working on the previous message here — ask again once that answer lands.",
			])
		}),
	)

	it.effect("tells a workspace nobody linked, once, and starts no turn", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([])
			const deployment = host(platform.outbound, agent.stub, { linked: false })

			yield* relayInboundEvent(mention, deployment.ports)

			expect(agent.turns).toEqual([])
			expect(notices(blocksOf(platform.calls))).toEqual([
				"This workspace isn't connected to a Maple organization yet — an admin can link it under Integrations in Maple.",
			])
			// The reply goes to the channel the mention was in: there is no conversation to open a
			// thread for, and nothing to say in it.
			expect(platform.threads).toEqual([])
			expect(platform.calls[0]?.ref.target).toEqual({
				workspaceId: WORKSPACE,
				channelId: CHANNEL,
			})
		}),
	)

	it.effect("stays quiet about an unlinked workspace the conversation was already told about", () =>
		Effect.gen(function* () {
			const platform = chat()
			const deployment = host(platform.outbound, session([]).stub, {
				linked: false,
				announceUnlinked: false,
			})

			yield* relayInboundEvent(mention, deployment.ports)

			expect(platform.calls).toEqual([])
		}),
	)

	it.effect("answers nothing at all when the workspace could not be looked up", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([])
			const deployment = host(platform.outbound, agent.stub, { lookupFails: true })

			yield* relayInboundEvent(mention, deployment.ports)

			// Saying "this workspace isn't connected" to one that IS connected sends an admin to make
			// a link that already exists.
			expect(platform.calls).toEqual([])
			expect(agent.turns).toEqual([])
		}),
	)

	it.effect("says so rather than going silent when the session cannot be reached", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([])
			const deployment = host(platform.outbound, {
				...agent.stub,
				beginTurn: () => Promise.reject(new Error("no such object")),
			})

			yield* relayInboundEvent(mention, deployment.ports)

			expect(notices(blocksOf(platform.calls))).toEqual([
				"Maple's agent can't be reached from here right now.",
			])
		}),
	)

	it.effect("keeps the conversation out of the telemetry when the platform refuses the turn", () =>
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
			const platform = chat()
			// The failure carries the request it failed on — and that request's body is the answer
			// being posted, or the thread title, which is the question that was asked.
			const refusing: ChatOutbound = {
				...platform.outbound,
				transport: Effect.map(platform.outbound.transport, (transport) => ({
					...transport,
					conversation: () =>
						Effect.fail(
							new ChatOutboundError({
								message: "the platform answered 403",
								connectorId: TESTCHAT,
								operation: "thread",
								cause: { body: `{"name":"${mention.text}"}` },
							}),
						),
				})),
			}
			const deployment = host(refusing, session([]).stub)

			yield* relayInboundEvent(mention, deployment.ports).pipe(
				Effect.provideContext(
					Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
						Context.add(Tracer.Tracer, tracer),
					),
				),
			)

			const everything = JSON.stringify({
				logs,
				spans: spans.map((span) => ({
					name: span.name,
					attributes: Object.fromEntries(span.attributes),
					// A failed span records the failure as an event, which is the other place a cause
					// would be rendered.
					events: span.events,
				})),
			})
			expect(everything).not.toContain(mention.text)
			expect(everything).not.toContain(mention.author.displayName)
			// The failure is still reported — by what it was, not by what it carried.
			expect(logs.join("")).toContain("ChatOutboundError")
		}),
	)

	it.effect("says so rather than going silent when no agent is bound", () =>
		Effect.gen(function* () {
			const platform = chat()
			const deployment = host(platform.outbound, undefined)

			yield* relayInboundEvent(mention, deployment.ports)

			expect(notices(blocksOf(platform.calls))).toEqual([
				"Maple's agent can't be reached from here right now.",
			])
		}),
	)
})

describe("relaying everything else a connector reports", () => {
	const approval: InboundAction = {
		type: "action",
		connector: TESTCHAT,
		workspaceId: WORKSPACE,
		channelId: CHANNEL,
		messageId: "message-2",
		actionToken: `${SESSION_ID}|call_9`,
		actor: { id: "author-1", displayName: "Ada", roleIds: [], isWorkspaceAdmin: true },
	}

	it.effect("answers an approval that Maple cannot act on one yet", () =>
		Effect.gen(function* () {
			const platform = chat()
			const deployment = host(platform.outbound, session([]).stub)

			yield* relayInboundEvent(approval, deployment.ports)

			expect(notices(blocksOf(platform.calls))).toEqual([
				"Approving a change from chat isn't available yet — open the conversation in Maple to apply it.",
			])
		}),
	)

	it.effect("unlinks a workspace the bot was removed from", () =>
		Effect.gen(function* () {
			const platform = chat()
			const deployment = host(platform.outbound, session([]).stub)
			const removed: InboundWorkspaceRemoved = {
				type: "workspace-removed",
				connector: TESTCHAT,
				workspaceId: WORKSPACE,
			}

			yield* relayInboundEvent(removed, deployment.ports)

			expect(deployment.forgotten).toEqual([WORKSPACE])
			// Nobody is there to read a reply about it.
			expect(platform.calls).toEqual([])
		}),
	)
})
