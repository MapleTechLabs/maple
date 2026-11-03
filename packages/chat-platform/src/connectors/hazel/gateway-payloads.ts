/**
 * Hazel's bot gateway frames, as far as this connector reads them.
 *
 * Decoded at the socket's edge and nowhere else. Every schema names only the fields the state
 * machine or the event mapping reads, so a field Hazel adds is ignored rather than fatal.
 */
import { Schema } from "effect"

export const HelloFrame = Schema.Struct({
	op: Schema.Literal("HELLO"),
	heartbeatIntervalMs: Schema.Finite,
})

export const ReadyFrame = Schema.Struct({
	op: Schema.Literal("READY"),
	sessionId: Schema.String,
	/** Who the bot is: a mention names it as `@[userId:<botUserId>]`. Absent from older gateways. */
	botUserId: Schema.optionalKey(Schema.String),
})

/** One event in a batch, undecoded: an envelope this connector cannot read is skipped, not fatal. */
export const DispatchFrame = Schema.Struct({
	op: Schema.Literal("DISPATCH"),
	sessionId: Schema.String,
	events: Schema.Array(Schema.Unknown),
	nextOffset: Schema.String,
})

export const HeartbeatAckFrame = Schema.Struct({ op: Schema.Literal("HEARTBEAT_ACK") })

export const ReconnectFrame = Schema.Struct({ op: Schema.Literal("RECONNECT"), reason: Schema.String })

export const InvalidSessionFrame = Schema.Struct({
	op: Schema.Literal("INVALID_SESSION"),
	reason: Schema.String,
})

export const ServerFrame = Schema.Union([
	HelloFrame,
	ReadyFrame,
	DispatchFrame,
	HeartbeatAckFrame,
	ReconnectFrame,
	InvalidSessionFrame,
])
export type ServerFrame = typeof ServerFrame.Type

export const decodeServerFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ServerFrame))

/** `message.create`, as far as a turn reads it. */
export const MessageCreateEnvelope = Schema.Struct({
	eventType: Schema.Literal("message.create"),
	/** `org:<orgId>:channel:<channelId>`: the only place the event names its workspace. */
	partitionKey: Schema.String,
	payload: Schema.Struct({
		id: Schema.String,
		channelId: Schema.String,
		authorId: Schema.String,
		content: Schema.String,
	}),
	author: Schema.optionalKey(
		Schema.Struct({ id: Schema.String, displayName: Schema.String, isBot: Schema.Boolean }),
	),
})

/** `interaction.create`: a button press on one of the bot's messages. */
export const InteractionCreateEnvelope = Schema.Struct({
	eventType: Schema.Literal("interaction.create"),
	payload: Schema.Struct({
		actionId: Schema.String,
		messageId: Schema.String,
		channelId: Schema.String,
		orgId: Schema.String,
		userId: Schema.String,
		userName: Schema.String,
	}),
})

export const decodeMessageCreate = Schema.decodeUnknownOption(MessageCreateEnvelope)
export const decodeInteractionCreate = Schema.decodeUnknownOption(InteractionCreateEnvelope)

/**
 * What INVALID_SESSION says when the token itself is refused. Nothing a reconnect fixes, so it
 * stops the loop until the host's fatal hold passes.
 */
export const INVALID_TOKEN_REASON = "Invalid bot token"

/**
 * What INVALID_SESSION says while another session holds the token — the previous connection, not
 * yet timed out. The gateway frees it on its own; a RESUME of that session replaces it sooner.
 */
export const SESSION_CONFLICT_REASON = "another active session already owns this bot token"

/** Close code for a reconnect the connector asked for: abnormal, so nothing reads it as a goodbye. */
export const RECONNECT_CLOSE_CODE = 4000
