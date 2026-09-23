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
	type ChatMessage,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { ChatConnectorId, OrgId } from "@maple/domain/primitives"
import {
	chatConnectorId,
	ChatOutboundError,
	type ChatBlock,
	type ChatChartRef,
	type ChatHistoryMessage,
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
	/** What the relay asked for the model's context, if it asked at all. */
	readonly historyCalls: Array<{ channelId: string; limit: number; before: string }>
}

/**
 * `earlier` is what this platform says was written in the conversation before the message — or a
 * failure, for a bot that may not read the history it is answering in.
 */
const chat = (earlier: ReadonlyArray<ChatHistoryMessage> | ChatOutboundError = []): Chat => {
	const calls: Chat["calls"] = []
	const threads: Array<string> = []
	const historyCalls: Chat["historyCalls"] = []
	let posted = 0
	return {
		calls,
		threads,
		historyCalls,
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
						// Only a mention opens a thread here, exactly as a real connector does: a message
						// that addressed nobody can continue a conversation but never start one.
						if (message.mentionsBot) threads.push(message.messageId)
						return {
							conversationKey: Schema.decodeSync(
								Schema.String.pipe(Schema.brand("@maple/ChatConversationKey")),
							)(CONVERSATION),
							target: { workspaceId: message.workspaceId, channelId: CONVERSATION },
							opened: message.mentionsBot,
						}
					}),
				history: (historyTarget, options) =>
					Effect.suspend(() => {
						historyCalls.push({ channelId: historyTarget.channelId, ...options })
						return earlier instanceof ChatOutboundError
							? Effect.fail(earlier)
							: Effect.succeed(earlier)
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

/** A turn that opens and closes with nothing said in it, for cases that are about the claim. */
const silentTurn: ReadonlyArray<ChatEvent> = [
	event(1, { type: "turn-start", messageId: "a1" }),
	event(2, { type: "turn-end", messageId: "a1", reason: "stop" }),
]

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
	options?: {
		readonly busy?: boolean
		/** What the session's transcript already holds, as `history()` answers it. */
		readonly transcript?: ReadonlyArray<ChatMessage>
	},
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
			history: () => Promise.resolve(options?.transcript ?? []),
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
	/** The conversations the host has been told the bot opened — the relay object's one durable fact. */
	readonly opened: Set<string>
	/** How many times the host was asked whether to announce an unlinked workspace. */
	readonly announced: { count: number }
	/** How many workspace lookups the events caused — one database connection each. */
	readonly lookups: { count: number }
}

const host = (
	outbound: ChatOutbound,
	stub: ChatSessionStub | undefined,
	options?: {
		readonly linked?: boolean
		readonly announceUnlinked?: boolean
		/** The database could not answer, which is not the same as nobody having linked it. */
		readonly lookupFails?: boolean
		/** A conversation the bot opened on some earlier event, as the relay object would remember it. */
		readonly opened?: ReadonlyArray<string>
	},
): Host => {
	const forgotten: Array<string> = []
	const charts: Array<{ orgId: OrgId; ref: ChatChartRef }> = []
	const opened = new Set<string>(options?.opened ?? [])
	const announced = { count: 0 }
	const lookups = { count: 0 }
	return {
		forgotten,
		charts,
		opened,
		announced,
		lookups,
		ports: {
			outbound,
			// Counted: this is a database connection per event, and a message the bot will not answer
			// must not open one.
			resolveWorkspace: (connector) =>
				Effect.suspend(() => {
					lookups.count += 1
					return options?.lookupFails === true
						? Effect.fail(
								new WorkspaceLookupFailed({
									connector,
									message: "the database said nothing",
								}),
							)
						: Effect.succeed(
								options?.linked === false ? Option.none() : Option.some({ orgId: ORG }),
							)
				}),
			forgetWorkspace: (_connector: ChatConnectorId, workspaceId: string) =>
				Effect.sync(() => void forgotten.push(workspaceId)),
			chatSession: () => stub,
			appBaseUrl: "https://app.maple.dev",
			chartImageUrl: (orgId, ref) => {
				charts.push({ orgId, ref })
				return `https://app.maple.dev/chat/chart/${ref.chartIndex}.png`
			},
			// Counted, not just answered: the real host spends a notice by being asked, so asking at
			// all in a conversation nothing will be said in is the bug.
			announceUnlinked: Effect.sync(() => {
				announced.count += 1
				return options?.announceUnlinked ?? true
			}),
			ownsConversation: (conversationKey) => Effect.sync(() => opened.has(conversationKey)),
			rememberConversation: (conversation) =>
				Effect.sync(() => void opened.add(conversation.conversationKey)),
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

	it.effect("gives the model what the conversation was already saying, and remembers it opened one", () =>
		Effect.gen(function* () {
			const platform = chat([{ displayName: "Bo", isBot: false, text: "checkout again", at: 1000 }])
			const agent = session([silentTurn])
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			// Read where the mention was written, and only what came before it: the conversation the
			// answer goes in is a thread that did not exist a moment ago.
			expect(platform.historyCalls).toEqual([
				{ channelId: CHANNEL, limit: 20, before: mention.messageId },
			])
			expect(agent.turns[0]?.text).toContain("Bo: checkout again")
			// And the conversation is now the bot's own, which is what lets the next message in it be
			// answered without a mention.
			expect([...deployment.opened]).toEqual([CONVERSATION])
		}),
	)

	it.effect("answers with less context rather than refusing when the history cannot be read", () =>
		Effect.gen(function* () {
			// A bot without permission to read the channel it was mentioned in, or a platform having a
			// bad minute. Either way somebody asked a question.
			const platform = chat(
				new ChatOutboundError({
					message: "the platform refused",
					connectorId: TESTCHAT,
					operation: "history",
					status: 403,
				}),
			)
			const agent = session([silentTurn])
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(mention, deployment.ports)

			expect(agent.turns).toHaveLength(1)
			expect(agent.turns[0]?.text).toContain("why is checkout slow?")
		}),
	)
})

describe("relaying a message that mentioned nobody", () => {
	const followUp: InboundMessage = {
		...mention,
		messageId: "message-2",
		// Where a platform gives a thread its own address, a follow-up in one arrives addressed to the
		// conversation itself rather than to the channel around it.
		channelId: CONVERSATION,
		text: "and the payments call?",
		mentionsBot: false,
	}

	/** A session that answered a minute ago, which is what makes the conversation live. */
	const answered: ReadonlyArray<ChatMessage> = [
		{
			id: "a1",
			role: "assistant",
			text: "Checkout is slow.",
			toolCalls: [],
			createdAt: Date.now() - 60_000,
			startSeq: 2,
		},
	]

	it.effect("answers it in a conversation the bot opened and spoke in recently", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([silentTurn], { transcript: answered })
			const deployment = host(platform.outbound, agent.stub, { opened: [CONVERSATION] })

			yield* relayInboundEvent(followUp, deployment.ports)

			expect(agent.turns).toHaveLength(1)
			expect(agent.turns[0]?.text).toContain("and the payments call?")
			// Nothing was opened for it: an unaddressed message continues a conversation, never starts
			// one.
			expect(platform.threads).toEqual([])
		}),
	)

	it.effect("gives the model only what its own transcript does not already hold", () =>
		Effect.gen(function* () {
			const answeredAt = answered[0]?.createdAt ?? 0
			const platform = chat([
				{ displayName: "Ada", isBot: false, text: "and the payments call?", at: answeredAt + 1000 },
				{ displayName: "Maple", isBot: true, text: "Checkout is slow.", at: answeredAt },
				{ displayName: "Ada", isBot: false, text: "why is checkout slow?", at: answeredAt - 1000 },
			])
			const agent = session([silentTurn], { transcript: answered })
			const deployment = host(platform.outbound, agent.stub, { opened: [CONVERSATION] })

			yield* relayInboundEvent(followUp, deployment.ports)

			const text = agent.turns[0]?.text ?? ""
			// What was said after the bot's own last answer, and nothing from before it: the session
			// replays that exchange into the same context window.
			expect(text).toContain("Ada: and the payments call?")
			expect(text).not.toContain("Maple (bot): Checkout is slow.")
			expect(text).not.toContain("Ada: why is checkout slow?")
		}),
	)

	it.effect("leaves a conversation the bot did not open completely alone", () =>
		Effect.gen(function* () {
			const platform = chat()
			const agent = session([silentTurn], { transcript: answered })
			const deployment = host(platform.outbound, agent.stub)

			yield* relayInboundEvent(followUp, deployment.ports)

			expect(agent.turns).toEqual([])
			// Not even a notice. Nobody asked it anything, so nothing appears in the conversation.
			expect(platform.calls).toEqual([])
			expect(platform.historyCalls).toEqual([])
			// And it stopped on a read of this object's own storage: no database connection, no call
			// to the session. On a deployment that sees every message, this is the path most of them
			// take.
			expect(deployment.lookups.count).toBe(0)
		}),
	)

	it.effect("stays mention-only when the session's own transcript cannot be read", () =>
		Effect.gen(function* () {
			// The transcript is what says the bot has spoken here and when. Unreadable is not "never
			// spoken", but it is the only safe reading of it: the alternative is answering on a guess.
			const platform = chat()
			const agent = session([silentTurn], { transcript: answered })
			const unreadable: ChatSessionStub = {
				...agent.stub,
				history: () => Promise.reject(new Error("the object was evicted")),
			}
			const deployment = host(platform.outbound, unreadable, { opened: [CONVERSATION] })

			yield* relayInboundEvent(followUp, deployment.ports)

			expect(agent.turns).toEqual([])
			expect(platform.calls).toEqual([])
		}),
	)

	it.effect("says nothing when there is nothing to say back", () =>
		Effect.gen(function* () {
			// Every notice a mention would get — the workspace nobody linked, the session that is
			// busy or unreachable — is a bot talking to a conversation that did not address it.
			const unlinkedChat = chat()
			const busyChat = chat()
			const unlinked = host(
				unlinkedChat.outbound,
				session([silentTurn], { transcript: answered }).stub,
				{
					linked: false,
					opened: [CONVERSATION],
				},
			)
			const busy = host(
				busyChat.outbound,
				session([silentTurn], { busy: true, transcript: answered }).stub,
				{
					opened: [CONVERSATION],
				},
			)

			yield* relayInboundEvent(followUp, unlinked.ports)
			yield* relayInboundEvent(followUp, busy.ports)

			expect(unlinkedChat.calls).toEqual([])
			expect(busyChat.calls).toEqual([])
			// And the unlinked notice is still unspent, so the next real mention here gets it.
			expect(unlinked.announced.count).toBe(0)
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
