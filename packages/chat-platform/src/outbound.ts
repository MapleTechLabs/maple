/**
 * What a connector has to be able to do to show a turn.
 *
 * Deliberately small, and every member is one that a platform with a real-time API and a
 * webhook-style one both have to answer for: somewhere to post, a way to change what was posted, a
 * budget the cutting has to respect, and how often the platform will accept a change. Formatting
 * is NOT in this contract — the transport takes blocks and renders them in its own dialect, so a
 * markdown flavour, an embed, a button and a mention syntax never leave the connector's directory.
 */
import type { ChatConversationKey } from "@maple/primitives"
import type { Duration, Effect } from "effect"
import { Context, Schema } from "effect"
import { ChatConnectorId } from "./connector"
import type { ConnectorConfig, ConnectorConfigKey, InboundAction, InboundMessage } from "./ingress"
import type { ChatBlock } from "./render/blocks"

/**
 * The configuration the host resolved for the connector it is driving.
 *
 * A transport needs its platform's credential, and the host may not know what any of them is
 * called — so it resolves the names the connector declared (`requiredConfig`) and supplies the map
 * under this one service. Two host-provided services then cover every connector's outbound half:
 * this and an HTTP client.
 */
export class ConnectorCredentials extends Context.Service<ConnectorCredentials, ConnectorConfig>()(
	"@maple/chat-platform/ConnectorCredentials",
) {}

/**
 * The entry under which the host puts the conversation's OWN stored credential into
 * {@link ConnectorCredentials}, when the connector's install minted one
 * (`ChatInstallResult.credentials`).
 *
 * A reserved name in the same map rather than a second service, because the map is already the one
 * thing the host resolves and the transport reads — and because the alternative, a per-workspace
 * service, would make every connector that does not need one declare it anyway. The name is not a
 * variable any deployment sets, so it cannot collide with a connector's declared config.
 *
 * Absent for a connector whose install returns no credential, and absent for a conversation in a
 * workspace nothing has linked. A transport that needs one must treat both as "cannot post".
 */
export const WORKSPACE_CREDENTIALS = "maple.chat.workspace_credentials"

/**
 * Where a turn is posted. Every id is an opaque string the connector minted or was handed.
 *
 * `workspaceId` rides on every call because it is what a connector with per-install credentials
 * resolves its token from, inside its own transport — the contract carries the address, never the
 * secret, and a connector with one process-wide credential simply ignores it.
 */
export interface ChatTarget {
	/** The install this conversation belongs to — a workspace, a guild, a team. */
	readonly workspaceId: string
	/** The channel, group or direct message. */
	readonly channelId: string
	/** The thread inside it, when the turn is answering in one. */
	readonly threadId?: string | undefined
}

/** A message this driver posted, and can still edit. Carries its target, so an edit is addressable. */
export interface ChatMessageRef {
	readonly target: ChatTarget
	readonly messageId: string
}

/**
 * Which conversation an inbound message belongs to, and where its answer goes.
 *
 * The key is what Maple's session id is built from, so a platform decides for itself what makes a
 * conversation one conversation — and is the only thing that could: a thread, a channel, or a
 * thread it has to open first are all the same question asked of different APIs.
 */
export interface ChatConversation {
	readonly conversationKey: ChatConversationKey
	readonly target: ChatTarget
	/**
	 * Whether the connector OPENED this conversation for the message, rather than answering in one
	 * that was already there.
	 *
	 * It is the difference between a space that exists because somebody asked Maple something and a
	 * channel a team was already using, and the host records it: only in a conversation of the
	 * bot's own is a message that never mentioned the bot still addressed to it.
	 */
	readonly opened: boolean
}

/**
 * One earlier message in a conversation, as far as the model needs to read it.
 *
 * No author id: the platform's own identifier has no use in a block of text a model reads, and the
 * contract does not carry an undecoded wire id that a later reader might brand.
 */
export interface ChatHistoryMessage {
	readonly displayName: string
	/** Maple's own earlier answers included — the model is told which lines are its. */
	readonly isBot: boolean
	/**
	 * Empty where the platform withholds content from the app. A message with nothing to read is
	 * left out of the context rather than rendered as a blank line.
	 */
	readonly text: string
	/** When it was sent, epoch ms. */
	readonly at: number
}

/** What a thread is opened around, and what it is called. */
export interface ChatThreadRequest {
	readonly workspaceId: string
	readonly channelId: string
	/** The message the thread hangs off — a mention, a command, an alert. */
	readonly anchorMessageId: string
	readonly title: string
}

/**
 * A channel in a linked workspace that the bot can post an alert to.
 *
 * `private` is what the connector could tell cheaply, not a promise: a channel reported as public
 * may still refuse a bot that was never invited, and the post says so.
 */
export interface ChatDestination {
	readonly id: string
	readonly name: string
	readonly private: boolean
}

export interface ChatOutboundLimits {
	/**
	 * Characters one message may carry. The budget the neutral cutting is held to, so it should sit
	 * under the platform's hard limit by whatever the connector's own decoration costs.
	 */
	readonly maxMessageChars: number
	/**
	 * How long to leave between two edits of the same message. A streamed turn produces hundreds of
	 * deltas a second and every platform rate-limits edits, so this is what the driver coalesces to.
	 */
	readonly minEditInterval: Duration.Duration
}

export interface ChatOutboundTransport {
	/**
	 * Post a message and answer with a handle to it.
	 *
	 * An empty block list is a message the driver has nothing to say in yet (or no longer has
	 * anything to say in, after a retry retracted it) — a connector must render it as something its
	 * platform accepts rather than as nothing.
	 */
	readonly post: (
		target: ChatTarget,
		blocks: ReadonlyArray<ChatBlock>,
	) => Effect.Effect<ChatMessageRef, ChatOutboundError>
	readonly edit: (
		ref: ChatMessageRef,
		blocks: ReadonlyArray<ChatBlock>,
	) => Effect.Effect<void, ChatOutboundError>
	/** Show the bot as busy while the first message is still on its way. Best effort by nature. */
	readonly typing: (target: ChatTarget) => Effect.Effect<void, ChatOutboundError>
	/**
	 * Open a thread around a message, and answer with the id to address it by.
	 *
	 * An answer belongs beside the question, not in the middle of a channel, and every platform
	 * worth connecting can put it there — but they disagree about what a thread IS. Where it is a
	 * first-class object this is an API call; where a thread is just replies to a message, the
	 * connector answers with the anchor's own id and performs no I/O at all. Either way the caller
	 * gets back something to put in {@link ChatTarget.threadId}.
	 *
	 * WHEN to open one is the caller's decision, not the driver's.
	 */
	readonly openThread: (request: ChatThreadRequest) => Effect.Effect<string, ChatOutboundError>
	/**
	 * Which conversation this event belongs to, opening a thread for a mention where the platform
	 * has them and the mention was not already in one.
	 *
	 * On the transport rather than beside the normalized event because answering can take I/O, and
	 * because the answer decides where every later call goes.
	 *
	 * An **action** is answered without opening anything: the click happened inside a conversation
	 * that already exists, so the connector names it. That answer is what scopes an approval — the
	 * host rebuilds the session id from it and refuses a control naming any other conversation — so
	 * a connector must derive it from the platform's own address for where the click landed, never
	 * from anything the control carried.
	 */
	readonly conversation: (
		event: InboundMessage | InboundAction,
	) => Effect.Effect<ChatConversation, ChatOutboundError>
	/**
	 * The messages written in this conversation before `before`, NEWEST FIRST.
	 *
	 * Newest first because the bound cuts the oldest: a conversation is read backwards from the
	 * message being answered, and every platform's own history API answers that way for the same
	 * reason. `limit` is a ceiling, not a demand — a conversation with less in it answers with less.
	 *
	 * What the host does with it is give the model the conversation it was mentioned in. A platform
	 * that will not hand over message content answers with empty `text`, which is a message the
	 * context leaves out rather than a failure.
	 */
	readonly history: (
		target: ChatTarget,
		options: { readonly limit: number; readonly before: string },
	) => Effect.Effect<ReadonlyArray<ChatHistoryMessage>, ChatOutboundError>
	/**
	 * The channels in a linked workspace an alert can be posted to, for a person picking one.
	 *
	 * The workspace is the platform's own id, as {@link ChatTarget.workspaceId} carries it. What
	 * counts as "can post to" is the connector's call — it lists what its platform will accept a
	 * message in, which is narrower than every channel a workspace has.
	 */
	readonly destinations: (
		workspaceId: string,
	) => Effect.Effect<ReadonlyArray<ChatDestination>, ChatOutboundError>
}

/**
 * A connector's outbound half.
 *
 * `transport` acquires the connector's dependencies — an HTTP client, its credential service —
 * and the returned methods close over them, so nothing downstream carries a connector's
 * implementation services in its requirements.
 */
export interface ChatOutbound<R = never> {
	/** Whose outbound this is — what a failure and a driver span name, without naming a vendor. */
	readonly connectorId: ChatConnectorId
	readonly limits: ChatOutboundLimits
	/**
	 * The deployment-wide configuration `transport` reads out of {@link ConnectorCredentials}.
	 *
	 * Declared so a host that posts without receiving anything — alert delivery — can resolve what
	 * a connector needs without knowing its name. A per-workspace credential is not listed here: it
	 * rides under {@link WORKSPACE_CREDENTIALS}.
	 */
	readonly requiredConfig: ReadonlyArray<ConnectorConfigKey>
	readonly transport: Effect.Effect<ChatOutboundTransport, never, R>
}

export class ChatOutboundError extends Schema.TaggedError<ChatOutboundError>()(
	"@maple/chat-platform/ChatOutboundError",
	{
		message: Schema.String,
		connectorId: ChatConnectorId,
		operation: Schema.Literals(["post", "edit", "typing", "thread", "history", "destinations"]),
		/** The platform's HTTP status, where the failure had one. */
		status: Schema.optionalKey(Schema.Finite),
		/**
		 * What the platform said was wrong, where it said so: the bot's grant (`auth`), the address
		 * (`not_found`), or the message itself (`rejected`). Absent for a failure worth retrying —
		 * a rate limit, an outage, a reply that could not be read.
		 */
		reason: Schema.optionalKey(Schema.Literals(["auth", "not_found", "rejected"])),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export type ChatOutboundOperation = ChatOutboundError["operation"]

export type ChatOutboundFailureReason = NonNullable<ChatOutboundError["reason"]>
