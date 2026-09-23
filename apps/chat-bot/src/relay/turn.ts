/**
 * What an inbound event causes: one turn on the conversation's chat session, streamed back into
 * the conversation it was asked in.
 *
 * Everything here is the generic half. The connector decides what a conversation IS and where a
 * reply goes (`transport.conversation`), the session decides what the agent says, and this decides
 * the order — resolve the org, claim the turn, render it — and what a reader is told when one of
 * those cannot happen. Nothing in this file knows which platform it is answering on.
 *
 * The side effects arrive as ports rather than services so the whole path is drivable without a
 * database, a Durable Object or a chat platform: `turn.test.ts` runs it end to end against a fake
 * connector.
 */
import {
	driveChatTurn,
	type ChatChartRef,
	type ChatConversation,
	type ChatHistoryMessage,
	type ChatOutbound,
	type ChatOutboundTransport,
	type ChatTarget,
	type InboundAction,
	type InboundEvent,
	type InboundMessage,
} from "@maple/chat-platform"
import {
	connectorSessionId,
	connectorTurnTenant,
	type ChatConversationKey,
	type ChatSessionId,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { ChatConnectorId, ExternalUserId, type OrgId } from "@maple/domain/primitives"
import { Clock, Duration, Effect, Exit, Option, Schema } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { chatTurnText, CONTEXT_MESSAGE_LIMIT, isFollowUpTurn } from "./conversation.ts"
import { chatTurnEvents, sessionUnreachable } from "./events.ts"

/** The org behind a workspace, as the host Worker answers it. */
export interface RelayWorkspace {
	readonly orgId: OrgId
}

/**
 * The database could not say whether this workspace is linked.
 *
 * Distinct from `None` on purpose, and the distinction is the whole point: telling a workspace that
 * IS linked that it is not sends an admin to make a link that already exists.
 */
export class WorkspaceLookupFailed extends Schema.TaggedError<WorkspaceLookupFailed>()(
	"@maple/chat-bot/WorkspaceLookupFailed",
	{ connector: ChatConnectorId, message: Schema.String },
) {}

export interface RelayPorts<R = never> {
	/** The connector's outbound half — how a turn is shown on the platform it was asked on. */
	readonly outbound: ChatOutbound<R>
	/** The org that linked this workspace, `None` when nobody has, and a failure when it cannot be read. */
	readonly resolveWorkspace: (
		connector: ChatConnectorId,
		workspaceId: string,
	) => Effect.Effect<Option.Option<RelayWorkspace>, WorkspaceLookupFailed>
	/** Drop the link for a workspace the bot was removed from. */
	readonly forgetWorkspace: (connector: ChatConnectorId, workspaceId: string) => Effect.Effect<void>
	/** The conversation's Durable Object, or `undefined` where this deployment has no agent bound. */
	readonly chatSession: (sessionId: ChatSessionId) => ChatSessionStub | undefined
	/** Base of the Maple web app, for the links a reply carries. */
	readonly appBaseUrl: string
	/** A signed image for one chart in a reply, or `null` when this deployment cannot sign one. */
	readonly chartImageUrl: (orgId: OrgId, ref: ChatChartRef) => string | null
	/**
	 * Whether the bot opened this conversation itself.
	 *
	 * What makes an unaddressed message answerable — see `./conversation.ts`. The host remembers it
	 * per conversation; a conversation nobody has recorded answers `false`, which is mention-only.
	 */
	readonly ownsConversation: (conversationKey: ChatConversationKey) => Effect.Effect<boolean>
	/** Record that the bot opened this conversation, before it says anything in it. */
	readonly rememberConversation: (conversation: ChatConversation) => Effect.Effect<void>
	/**
	 * Whether to say anything about a workspace nobody has linked.
	 *
	 * Once a conversation has been told, repeating it on every mention is a bot flooding a channel
	 * it cannot even answer in — so the host answers this from what it last said here.
	 */
	readonly announceUnlinked: Effect.Effect<boolean>
}

/**
 * How long a relayed turn may run before it is abandoned.
 *
 * The session ends a turn of its own accord — the run finishes, or its heartbeat fails a turn
 * whose object was evicted — so this is the bound on everything that could keep the stream open
 * without one, and it matches the session's own staleness ceiling.
 */
const RELAY_TIMEOUT = Duration.minutes(15)

const UNLINKED_NOTICE =
	"This workspace isn't connected to a Maple organization yet — an admin can link it under Integrations in Maple."

const BUSY_NOTICE = "Still working on the previous message here — ask again once that answer lands."

const UNAVAILABLE_NOTICE = "Maple's agent can't be reached from here right now."

const APPROVAL_NOTICE =
	"Approving a change from chat isn't available yet — open the conversation in Maple to apply it."

const decodeExternalUserId = Schema.decodeUnknownOption(ExternalUserId)

/** Where a reply that is not a turn goes: the conversation the message was written in. */
const replyTarget = (message: InboundMessage | InboundAction): ChatTarget => ({
	workspaceId: message.workspaceId,
	channelId: message.channelId,
	// Absent on platforms where a thread IS a channel, which `channelId` then already addresses.
	threadId: "threadId" in message ? message.threadId : undefined,
})

const notice = (text: string) => [{ kind: "notice" as const, tone: "info" as const, text }]

/** Say one short thing, and let a platform that refuses it be a log line rather than a failure. */
const say = (transport: ChatOutboundTransport, target: ChatTarget, text: string) =>
	transport.post(target, notice(text)).pipe(
		Effect.asVoid,
		Effect.tapError((error) =>
			Effect.logWarning("Chat notice could not be posted").pipe(
				Effect.annotateLogs({ "error.type": error.operation }),
			),
		),
		Effect.ignore,
	)

const relayMessage = Effect.fn("chat_bot.relay_turn")(function* <R>(
	message: InboundMessage,
	ports: RelayPorts<R>,
) {
	yield* Effect.annotateCurrentSpan({
		"maple.chat.connector": message.connector,
		"maple.chat.mentioned": message.mentionsBot,
	})
	const transport = yield* ports.outbound.transport
	const author = decodeExternalUserId(message.author.id)
	// An author the platform cannot name is nobody to attribute a turn to.
	if (Option.isNone(author)) return yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "no_author" })

	/**
	 * Notices go to the person who asked, and nobody asked here: a message that did not mention the
	 * bot and is not answered leaves no trace in the conversation at all.
	 */
	const tell = (target: ChatTarget, text: string) =>
		message.mentionsBot ? say(transport, target, text) : Effect.void

	const workspace = yield* Effect.exit(ports.resolveWorkspace(message.connector, message.workspaceId))
	// A lookup that failed says nothing about whether this workspace is linked, so the mention goes
	// unanswered rather than answered wrongly. The port has already logged why.
	if (Exit.isFailure(workspace)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "unavailable" })
	}
	if (Option.isNone(workspace.value)) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "unlinked" })
		// Asked before the notice is claimed, not after: an unaddressed message that says nothing
		// must not spend the one notice this conversation gets an hour.
		if (message.mentionsBot && (yield* ports.announceUnlinked)) {
			yield* say(transport, replyTarget(message), UNLINKED_NOTICE)
		}
		return
	}
	const { orgId } = workspace.value.value

	const conversation = yield* transport.conversation(message)
	// Recorded before anything is said in it, so a turn that then fails still leaves a conversation
	// the bot will go on answering in.
	if (conversation.opened) yield* ports.rememberConversation(conversation)
	const sessionId = connectorSessionId(orgId, message.connector, conversation.conversationKey)
	yield* Effect.annotateCurrentSpan({ orgId, "maple.chat.session_id": sessionId })

	const session = ports.chatSession(sessionId)
	if (session === undefined) {
		yield* Effect.logError("No chat session binding on this deployment")
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "no_binding" })
		return yield* tell(conversation.target, UNAVAILABLE_NOTICE)
	}

	// What the conversation's session already holds, which is both what decides an unaddressed
	// message and what the context block must not repeat. A session that cannot be read answers
	// neither: `0` leaves the whole context in and takes no follow-up. It degrades the turn twice
	// over, so it is logged rather than swallowed.
	const transcript = yield* Effect.tryPromise({
		catch: sessionUnreachable(sessionId, "The chat session's transcript could not be read"),
		try: () => session.history(),
	}).pipe(
		Effect.tapError((error) =>
			Effect.logWarning("Chat session transcript could not be read").pipe(
				Effect.annotateLogs({ "error.type": error._tag }),
			),
		),
		Effect.orElseSucceed(() => []),
	)
	const seenUpTo = transcript[transcript.length - 1]?.createdAt ?? 0
	const now = yield* Clock.currentTimeMillis

	if (!message.mentionsBot) {
		const ownsConversation = yield* ports.ownsConversation(conversation.conversationKey)
		// Recorded whichever way the gate goes: "the bot does not own this conversation" and "it does,
		// but the window closed" are the same outcome and different problems, and the second is the
		// one that would move `FOLLOW_UP_WINDOW_MS`.
		yield* Effect.annotateCurrentSpan({ "maple.chat.owns_conversation": ownsConversation })
		if (!isFollowUpTurn({ message, ownsConversation, lastTurnAt: seenUpTo, now })) {
			return yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "not_addressed" })
		}
	}

	// Best effort: a conversation whose history the bot may not read is one it answers with less
	// context, not one it refuses to answer in.
	const recent = yield* transport
		.history(replyTarget(message), { limit: CONTEXT_MESSAGE_LIMIT, before: message.messageId })
		.pipe(
			Effect.tapError((error) =>
				// The status and the reason, not just the operation: a permission the bot was never
				// granted and a one-off 5xx otherwise produce identical lines, and the first means
				// every turn from here on answers with no context at all.
				Effect.logWarning("Chat conversation history could not be read").pipe(
					Effect.annotateLogs({
						"error.type": error.operation,
						"error.message": error.message,
						"http.response.status_code": error.status ?? 0,
					}),
				),
			),
			Effect.orElseSucceed((): ReadonlyArray<ChatHistoryMessage> => []),
		)

	const claimed = yield* Effect.tryPromise({
		catch: sessionUnreachable(sessionId, "The chat session did not accept a turn"),
		try: () =>
			session.beginTurn({
				sessionId,
				messageId: crypto.randomUUID(),
				text: chatTurnText(message, { now, recent, seenUpTo }),
				tenant: connectorTurnTenant(orgId),
				origin: {
					kind: "connector",
					connectorId: message.connector,
					workspaceId: message.workspaceId,
					externalUserId: author.value,
					displayName: message.author.displayName,
				},
			}),
	}).pipe(Effect.exit)
	// A session that cannot be reached at all, as opposed to one that answered. Silence is the wrong
	// reply to either — somebody asked a question.
	if (Exit.isFailure(claimed)) {
		yield* Effect.logError("A chat turn could not be claimed").pipe(
			Effect.annotateLogs({ "error.type": summarizeCause(claimed.cause) }),
		)
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "unreachable" })
		return yield* tell(conversation.target, UNAVAILABLE_NOTICE)
	}
	// A turn is already running in this conversation. Nothing is queued: the reader asked while the
	// answer to their last question was still being written, and the thread already shows it.
	if (claimed.value === undefined) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "busy" })
		return yield* tell(conversation.target, BUSY_NOTICE)
	}

	yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "started" })
	yield* driveChatTurn({
		// From the cursor the claim answered with, so the turn's own first event is the first one
		// this sees.
		events: chatTurnEvents(session, sessionId, claimed.value.cursor),
		messageId: claimed.value.turnMessageId,
		outbound: ports.outbound,
		target: conversation.target,
		context: {
			appBaseUrl: ports.appBaseUrl,
			sessionId,
			chartImageUrl: (ref) => ports.chartImageUrl(orgId, ref),
		},
	}).pipe(Effect.timeout(RELAY_TIMEOUT))
})

/**
 * A click on an approval the agent proposed.
 *
 * The connector has already acknowledged the click to its platform (ingress issues that request
 * itself, under the platform's own deadline), so what is left is telling the reader that Maple
 * cannot act on it yet. Applying a proposed mutation is the next change, and it starts here: the
 * token is untrusted wire input, read with `decodeChatActionToken`, never branded on arrival.
 */
const acknowledgeAction = Effect.fnUntraced(function* <R>(action: InboundAction, ports: RelayPorts<R>) {
	const transport = yield* ports.outbound.transport
	yield* say(transport, replyTarget(action), APPROVAL_NOTICE)
})

/**
 * A switch rather than a chain of ternaries: an event kind added to the contract has to be answered
 * here rather than quietly taking the last branch. The error channel is erased because every
 * failure is caught below — nothing above this can do anything with one.
 */
const relayed = <R>(event: InboundEvent, ports: RelayPorts<R>): Effect.Effect<void, unknown, R> => {
	switch (event.type) {
		case "message":
			return relayMessage(event, ports)
		case "action":
			return acknowledgeAction(event, ports)
		case "workspace-removed":
			// Unlink it and say nothing: there is nobody left in there to read a reply.
			return ports.forgetWorkspace(event.connector, event.workspaceId)
	}
}

/**
 * Everything one inbound event causes, with nothing left for the caller to handle.
 *
 * A failure here reaches no user and no retry — the platform has moved on — so it is logged against
 * the connector and the workspace, and never the conversation. The cause is SUMMARIZED rather than
 * rendered: an outbound failure carries the HTTP request it failed on, whose body is the answer
 * being posted and whose thread title is the question that was asked.
 */
export const relayInboundEvent = <R>(
	event: InboundEvent,
	ports: RelayPorts<R>,
): Effect.Effect<void, never, R> =>
	relayed(event, ports).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("Chat connector event could not be relayed").pipe(
				Effect.annotateLogs({
					"maple.chat.connector": event.connector,
					"maple.chat.workspace_id": event.workspaceId,
					"error.type": summarizeCause(cause),
				}),
			),
		),
	)
