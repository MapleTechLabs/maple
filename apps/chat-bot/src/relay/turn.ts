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
	decodeChatActionControlId,
	driveChatTurn,
	type ChatActionRequest,
	type ChatChartRef,
	type ChatOutbound,
	type ChatOutboundTransport,
	type ChatTarget,
	type InboundAction,
	type InboundEvent,
	type InboundMessage,
} from "@maple/chat-platform"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import {
	connectorSessionId,
	connectorTurnTenant,
	type ChatMessage,
	type ChatSessionId,
} from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { ChatConnectorId, ExternalUserId, type OrgId, type UserId } from "@maple/domain/primitives"
import { Duration, Effect, Exit, Option, Schema } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { settledMessageBlocks } from "./approval.ts"
import { chatTurnEvents, sessionUnreachable } from "./events.ts"

/** The org behind a workspace, and who the person acting is in Maple, when one was asked about. */
export interface RelayWorkspace {
	readonly orgId: OrgId
	/**
	 * The Maple user the `externalUserId` that was asked about is linked to in that org.
	 *
	 * Absent means nobody has linked it — which is a refusal on a connector that can prove who
	 * clicked, and irrelevant on one that cannot (and on a mention, which never asks).
	 */
	readonly linkedUserId?: UserId
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
	/**
	 * The org that linked this workspace, `None` when nobody has, and a failure when it cannot be
	 * read.
	 *
	 * `externalUserId` asks a second question in the same database connection: which Maple user
	 * that chat account is linked to. A mention omits it; an approval passes it, and the host skips
	 * the query anyway when the connector has no `identity` half to link with.
	 */
	readonly resolveWorkspace: (
		connector: ChatConnectorId,
		workspaceId: string,
		externalUserId?: string,
	) => Effect.Effect<Option.Option<RelayWorkspace>, WorkspaceLookupFailed>
	/**
	 * Whether this connector can prove who clicked a button.
	 *
	 * The connector's `identity` half, as a fact rather than a function: the host knows which
	 * connector it is running and this file must not.
	 */
	readonly supportsIdentity: boolean
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

/** The control outlived what it pointed at: a wiped conversation, or a build that changed the log. */
const PROPOSAL_GONE_NOTICE = "That change isn't waiting for a decision any more."

/** Where somebody goes to link their account — Maple's own page, which is where a session is. */
const LINK_NOTICE = (appBaseUrl: string) =>
	`Link your chat account to Maple before approving changes: ${appBaseUrl}/integrations`

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

	const workspace = yield* Effect.exit(ports.resolveWorkspace(message.connector, message.workspaceId))
	// A lookup that failed says nothing about whether this workspace is linked, so the mention goes
	// unanswered rather than answered wrongly. The port has already logged why.
	if (Exit.isFailure(workspace)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "unavailable" })
	}
	if (Option.isNone(workspace.value)) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.relay": "unlinked" })
		if (yield* ports.announceUnlinked) yield* say(transport, replyTarget(message), UNLINKED_NOTICE)
		return
	}
	const { orgId } = workspace.value.value

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
 * itself, under the platform's own deadline), so everything here runs at its own pace. The order
 * is the point:
 *
 *   1. read the control — untrusted wire input, never branded on arrival;
 *   2. resolve the workspace and decide whether this person may approve anything here;
 *   3. hand the SESSION the decision, which finds the proposal in its own log and runs it.
 *
 * Nothing the click carried reaches the tool. The control names a session and a call, the session
 * reads the tool's name and arguments out of the transcript, and a control naming a session in
 * another org is refused before the session is reached at all.
 */
const settleAction = Effect.fn("chat_bot.settle_approval")(function* <R>(
	action: InboundAction,
	ports: RelayPorts<R>,
) {
	yield* Effect.annotateCurrentSpan({ "maple.chat.connector": action.connector })
	const control = decodeChatActionControlId(action.actionToken)
	// A platform hands back whatever was on the control that was clicked, which includes controls
	// Maple never rendered. Not ours is not an error.
	if (Option.isNone(control)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "not_a_control" })
	}
	const request = control.value

	const transport = yield* ports.outbound.transport
	const approver = decodeExternalUserId(action.actor.id)
	if (Option.isNone(approver)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "no_approver" })
	}

	const workspace = yield* Effect.exit(
		ports.resolveWorkspace(action.connector, action.workspaceId, approver.value),
	)
	// Unreadable, or unlinked: either way there is no org to make a change in. The port logged why.
	if (Exit.isFailure(workspace) || Option.isNone(workspace.value)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "unavailable" })
	}
	const { orgId, linkedUserId } = workspace.value.value
	// Not before here: the org is the workspace's, never the control's, and an approval nobody can
	// attribute to an org is not answerable to an auditor.
	yield* Effect.annotateCurrentSpan({ orgId })

	// The control names its own session, and the session it is allowed to name is THIS conversation's
	// — rebuilt from the org that owns the workspace and the conversation the connector says the
	// click landed in, neither of which came off the control.
	//
	// The org alone is not enough. A control is forgeable by design (see `action-token.ts`), so an
	// approver in one channel could otherwise settle a proposal raised in a channel they cannot
	// read, and the settling edit would then render that conversation's answer into theirs.
	const conversation = yield* transport.conversation(action)
	if (request.sessionId !== connectorSessionId(orgId, action.connector, conversation.conversationKey)) {
		return yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "foreign_session" })
	}

	// See `ChatConnector.identity` for the policy: a connector that can name the clicker requires a
	// link, and one that cannot lets anyone in the conversation decide.
	if (ports.supportsIdentity && linkedUserId === undefined) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "unlinked" })
		return yield* say(transport, replyTarget(action), LINK_NOTICE(ports.appBaseUrl))
	}
	yield* Effect.annotateCurrentSpan({
		"maple.chat.approval.as": linkedUserId === undefined ? "connector" : "user",
	})

	const session = ports.chatSession(request.sessionId)
	if (session === undefined) {
		yield* Effect.logError("No chat session binding on this deployment")
		yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "no_binding" })
		return yield* say(transport, replyTarget(action), UNAVAILABLE_NOTICE)
	}

	const outcome = yield* Effect.tryPromise({
		catch: sessionUnreachable(request.sessionId, "The chat session did not accept a decision"),
		try: () =>
			session.settleProposal({
				sessionId: request.sessionId,
				toolCallId: request.toolCallId,
				decision: request.decision,
				approver: {
					kind: "connector",
					connectorId: action.connector,
					workspaceId: action.workspaceId,
					externalUserId: approver.value,
					displayName: action.actor.displayName,
				},
				// Only ever the user the HOST resolved from its own database, never anything the
				// click carried: this is what the change runs as.
				...(linkedUserId === undefined ? undefined : { actingUserId: linkedUserId }),
			}),
	}).pipe(Effect.exit)
	if (Exit.isFailure(outcome)) {
		yield* Effect.logError("A chat approval could not be settled").pipe(
			Effect.annotateLogs({ "error.type": summarizeCause(outcome.cause) }),
		)
		yield* Effect.annotateCurrentSpan({ "maple.chat.approval": "unreachable" })
		return yield* say(transport, replyTarget(action), UNAVAILABLE_NOTICE)
	}
	yield* Effect.annotateCurrentSpan({ "maple.chat.approval": outcome.value })

	// A switch rather than a chain of ternaries, for the reason `relayed` below is one: an outcome
	// added to the contract has to be answered here rather than quietly taking the last branch,
	// which for this one would mean editing the message after a decision that never happened.
	switch (outcome.value) {
		case "settled":
			// Somebody got there first. The message already shows what was decided, so a second click
			// changes nothing — including what it says.
			return
		case "unknown":
			return yield* say(transport, replyTarget(action), PROPOSAL_GONE_NOTICE)
		case "decided":
			// A transcript that could not be re-read has already been logged; the decision stands
			// either way, so the reader sees an unchanged message rather than a second failure.
			return yield* showDecision(action, request, orgId, session, ports).pipe(Effect.ignore)
		default:
			return outcome.value satisfies never
	}
})

/**
 * Put the decision on the message that carried the controls.
 *
 * Re-read rather than reported: the session's log is what the decision produced, and rendering it
 * the way the turn itself is rendered is what keeps one description of an approval in the codebase.
 */
const showDecision = Effect.fn("chat_bot.show_decision")(function* <R>(
	action: InboundAction,
	request: ChatActionRequest,
	orgId: OrgId,
	session: ChatSessionStub,
	ports: RelayPorts<R>,
) {
	// A transcript that cannot be read leaves the decision applied and the message unchanged, which
	// is confusing enough to be worth a line: the alternative is a silent degradation that looks
	// exactly like the platform refusing the edit.
	const history = yield* Effect.tryPromise({
		catch: sessionUnreachable(request.sessionId, "The chat session did not answer with its history"),
		try: () => session.history(),
	}).pipe(
		Effect.tapError((error) =>
			Effect.logWarning("A settled approval could not be re-read").pipe(
				Effect.annotateLogs({ "error.type": error._tag }),
			),
		),
	)
	// The session just settled this call, so its message is there.
	const message = history.find((candidate) =>
		candidate.toolCalls.some((call) => call.id === request.toolCallId),
	)
	if (message === undefined) return
	const transport = yield* ports.outbound.transport
	const blocks = settledMessageBlocks(
		message,
		request.toolCallId,
		{
			appBaseUrl: ports.appBaseUrl,
			sessionId: request.sessionId,
			chartImageUrl: (ref) => ports.chartImageUrl(orgId, ref),
		},
		ports.outbound.limits.maxMessageChars,
	)
	yield* transport.edit({ target: replyTarget(action), messageId: action.messageId }, blocks).pipe(
		Effect.tapError((error) =>
			Effect.logWarning("A settled approval could not be shown").pipe(
				Effect.annotateLogs({ "error.type": error.operation }),
			),
		),
		Effect.ignore,
	)
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
			return settleAction(event, ports)
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
