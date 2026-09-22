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
import type { ConnectorConfig, InboundAction, InboundMessage } from "./ingress"
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
}

/** What a thread is opened around, and what it is called. */
export interface ChatThreadRequest {
	readonly workspaceId: string
	readonly channelId: string
	/** The message the thread hangs off — a mention, a command, an alert. */
	readonly anchorMessageId: string
	readonly title: string
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
	readonly transport: Effect.Effect<ChatOutboundTransport, never, R>
}

export class ChatOutboundError extends Schema.TaggedError<ChatOutboundError>()(
	"@maple/chat-platform/ChatOutboundError",
	{
		message: Schema.String,
		connectorId: ChatConnectorId,
		operation: Schema.Literals(["post", "edit", "typing", "thread"]),
		/** The platform's HTTP status, where the failure had one. */
		status: Schema.optionalKey(Schema.Finite),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export type ChatOutboundOperation = ChatOutboundError["operation"]
