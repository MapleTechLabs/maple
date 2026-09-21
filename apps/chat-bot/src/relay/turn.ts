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
	type ChatOutbound,
	type ChatOutboundTransport,
	type ChatTarget,
	type InboundAction,
	type InboundEvent,
	type InboundMessage,
} from "@maple/chat-platform"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import { connectorSessionId, connectorTurnTenant, type ChatSessionId } from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { ChatConnectorId, ExternalUserId, type OrgId } from "@maple/domain/primitives"
import { Duration, Effect, Exit, Option, Schema } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { chatTurnEvents, sessionUnreachable } from "./events.ts"

/** The org behind a workspace, as the host Worker answers it. */
export interface RelayWorkspace {
	readonly orgId: OrgId
}

export interface RelayPorts<R = never> {
	/** The connector's outbound half — how a turn is shown on the platform it was asked on. */
	readonly outbound: ChatOutbound<R>
	/** The org that linked this workspace, or `None` when nobody has. */
	readonly resolveWorkspace: (
		connector: ChatConnectorId,
		workspaceId: string,
	) => Effect.Effect<Option.Option<RelayWorkspace>>
	/** Drop the link for a workspace the bot was removed from. */
	readonly forgetWorkspace: (connector: ChatConnectorId, workspaceId: string) => Effect.Effect<void>
	/** The conversation's Durable Object, or `undefined` where this deployment has no agent bound. */
	readonly chatSession: (sessionId: ChatSessionId) => ChatSessionStub | undefined
	/** Base of the Maple web app, for the links a reply carries. */
	readonly appBaseUrl: string
	/** A signed image for one chart in a reply, or `null` when this deployment cannot sign one. */
	readonly chartImageUrl: (orgId: OrgId, ref: ChatChartRef) => string | null
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

/**
 * The turn's text: who is speaking, then what they said.
 *
 * Fenced as machine-written context, because it is — several people share a conversation, the
 * model needs to know which of them it is answering, and the sentence is not something anybody
 * typed.
 */
const turnText = (message: InboundMessage): string =>
	wrapChatContext(
		`${message.author.displayName} is asking, in a chat conversation other people can read.`,
		message.text,
	)

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
	yield* Effect.annotateCurrentSpan({ "maple.chat.connector": message.connector })
	const transport = yield* ports.outbound.transport
	const author = decodeExternalUserId(message.author.id)
	// An author the platform cannot name is nobody to attribute a turn to.
	if (Option.isNone(author)) return yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "no_author" })

	const workspace = yield* ports.resolveWorkspace(message.connector, message.workspaceId)
	if (Option.isNone(workspace)) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "unlinked" })
		if (yield* ports.announceUnlinked) yield* say(transport, replyTarget(message), UNLINKED_NOTICE)
		return
	}
	const { orgId } = workspace.value

	const conversation = yield* transport.conversation(message)
	const sessionId = connectorSessionId(orgId, message.connector, conversation.conversationKey)
	yield* Effect.annotateCurrentSpan({ orgId, "maple.chat.session_id": sessionId })

	const session = ports.chatSession(sessionId)
	if (session === undefined) {
		yield* Effect.logError("No chat session binding on this deployment")
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "no_binding" })
		return yield* say(transport, conversation.target, UNAVAILABLE_NOTICE)
	}

	const claimed = yield* Effect.tryPromise({
		catch: sessionUnreachable(sessionId, "The chat session did not accept a turn"),
		try: () =>
			session.beginTurn({
				sessionId,
				messageId: crypto.randomUUID(),
				text: turnText(message),
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
		return yield* say(transport, conversation.target, UNAVAILABLE_NOTICE)
	}
	// A turn is already running in this conversation. Nothing is queued: the reader asked while the
	// answer to their last question was still being written, and the thread already shows it.
	if (claimed.value === undefined) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "busy" })
		return yield* say(transport, conversation.target, BUSY_NOTICE)
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
