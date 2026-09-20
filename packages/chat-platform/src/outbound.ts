/**
 * What a connector has to be able to do to show a turn.
 *
 * Deliberately small, and every member is one that a platform with a real-time API and a
 * webhook-style one both have to answer for: somewhere to post, a way to change what was posted, a
 * budget the cutting has to respect, and how often the platform will accept a change. Formatting
 * is NOT in this contract — the transport takes blocks and renders them in its own dialect, so a
 * markdown flavour, an embed, a button and a mention syntax never leave the connector's directory.
 */
import type { Duration, Effect } from "effect"
import { Schema } from "effect"
import { ChatConnectorId } from "./connector"
import type { ChatBlock } from "./render/blocks"

/** Where a turn is posted. Both ids are opaque strings the connector minted or was handed. */
export interface ChatTarget {
	/** The platform conversation — a channel, a thread, a direct message. */
	readonly conversationId: string
	/** The message this turn answers, where the platform threads replies. */
	readonly replyToMessageId?: string | undefined
}

/** A message this driver posted, and can still edit. */
export interface ChatMessageRef {
	readonly conversationId: string
	readonly messageId: string
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
}

/**
 * A connector's outbound half.
 *
 * `transport` acquires the connector's dependencies — an HTTP client, its credential service —
 * and the returned methods close over them, so nothing downstream carries a connector's
 * implementation services in its requirements.
 */
export interface ChatOutbound<R = never> {
	readonly limits: ChatOutboundLimits
	readonly transport: Effect.Effect<ChatOutboundTransport, never, R>
}

export class ChatOutboundError extends Schema.TaggedError<ChatOutboundError>()(
	"@maple/chat-platform/ChatOutboundError",
	{
		message: Schema.String,
		connectorId: ChatConnectorId,
		operation: Schema.Literals(["post", "edit", "typing"]),
		/** The platform's HTTP status, where the failure had one. */
		status: Schema.optionalKey(Schema.Finite),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export type ChatOutboundOperation = ChatOutboundError["operation"]
