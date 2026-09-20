/**
 * The Discord Gateway v10 wire vocabulary, as far as this connector reads it.
 *
 * Every schema here is deliberately partial: Discord's payloads are large and
 * most of each one is irrelevant, and Effect Schema drops the keys a struct does
 * not name, so adding a field to a payload upstream cannot break decoding here.
 *
 * Verified against the Gateway and Gateway Events references (API v10).
 */
import { Schema } from "effect"

/** `wss://gateway.discord.gg/?v=10&encoding=json` — JSON, uncompressed, single shard. */
export const GATEWAY_QUERY = "?v=10&encoding=json"
export const GATEWAY_URL = `wss://gateway.discord.gg/${GATEWAY_QUERY}`

/** The REST base the interaction acknowledgement is issued against. */
export const API_BASE_URL = "https://discord.com/api/v10"

/** Receive and send opcodes this connector acts on. Others are ignored. */
export const OP = {
	dispatch: 0,
	heartbeat: 1,
	identify: 2,
	resume: 6,
	reconnect: 7,
	invalidSession: 9,
	hello: 10,
	heartbeatAck: 11,
} as const

/**
 * `GUILDS | GUILD_MESSAGES` (`1 << 0 | 1 << 9`).
 *
 * `GUILDS` is what delivers `GUILD_DELETE`, which is how the bot learns it was
 * removed from a server. `GUILD_MESSAGES` delivers `MESSAGE_CREATE`.
 *
 * `MESSAGE_CONTENT` (`1 << 15`) is deliberately NOT requested. It is privileged,
 * and the documented exceptions cover exactly the V1 product: content is
 * delivered without it for messages the app sends, DMs with the app, and
 * **messages in which the app is mentioned**. Mention-only is therefore not a
 * limitation worked around — it is the reason the bot needs no privileged
 * intent at all. Anything that wants to read messages the bot was not addressed
 * in has to ask Discord for the intent first.
 *
 * `INTERACTION_CREATE` is not gated by any intent, so approval buttons work on
 * this set too.
 */
export const INTENTS = (1 << 0) | (1 << 9)

/** Interaction types (`type` on an `INTERACTION_CREATE`). Only the component click matters here. */
export const INTERACTION_MESSAGE_COMPONENT = 3

/** Interaction callback type 6: acknowledge the click, leave the message as it is. */
export const CALLBACK_DEFERRED_UPDATE_MESSAGE = 6

/**
 * Close codes Discord documents as non-reconnectable.
 *
 * Two groups, both of which must stop the loop rather than retry it. `4004`,
 * `4010`–`4014` are configuration: a bad token, a shard count the bot does not
 * use, an API version that no longer exists, an intent the application has not
 * been granted. `4001`–`4005` say this client sent something wrong; reconnecting
 * would send it again. Either way the answer is one reported failure, not an
 * endless loop against Discord's rate limiter.
 */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
	4001, 4002, 4003, 4004, 4005, 4010, 4011, 4012, 4013, 4014,
])

/**
 * Close codes that invalidate the session but not the connection attempt: the
 * stored sequence was rejected (`4007`) or the session aged out (`4009`). Both
 * reconnect, but only after forgetting the session so the next handshake is a
 * fresh IDENTIFY instead of a RESUME that would be rejected the same way.
 */
export const SESSION_RESET_CLOSE_CODES: ReadonlySet<number> = new Set([4007, 4009])

/**
 * Any code other than 1000/1001 when reconnecting.
 *
 * Discord keeps a session resumable across an abnormal close and ends it on a
 * clean one, and its own zombie-connection guidance is explicit: terminate with
 * a code other than 1000 or 1001, then resume.
 */
export const RECONNECT_CLOSE_CODE = 4000

/** The envelope every gateway frame arrives in. */
export const GatewayFrame = Schema.Struct({
	op: Schema.Number,
	d: Schema.optional(Schema.Unknown),
	s: Schema.optional(Schema.NullOr(Schema.Number)),
	t: Schema.optional(Schema.NullOr(Schema.String)),
})
export type GatewayFrame = Schema.Schema.Type<typeof GatewayFrame>

export const decodeGatewayFrame = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayFrame))

export const Hello = Schema.Struct({ heartbeat_interval: Schema.Number })
export const decodeHello = Schema.decodeUnknownOption(Hello)

export const Ready = Schema.Struct({
	session_id: Schema.String,
	resume_gateway_url: Schema.String,
	user: Schema.Struct({ id: Schema.String }),
})
export const decodeReady = Schema.decodeUnknownOption(Ready)

const User = Schema.Struct({
	id: Schema.String,
	username: Schema.String,
	global_name: Schema.optional(Schema.NullOr(Schema.String)),
	bot: Schema.optional(Schema.Boolean),
})

export const MessageCreate = Schema.Struct({
	id: Schema.String,
	channel_id: Schema.String,
	/** Absent on a DM. This connector requests no DM intent, so a message without it is dropped. */
	guild_id: Schema.optional(Schema.String),
	author: User,
	/**
	 * Empty unless the message qualifies under one of the MESSAGE_CONTENT
	 * exceptions — for this bot, unless it was mentioned.
	 */
	content: Schema.String,
	mentions: Schema.Array(User),
	member: Schema.optional(Schema.Struct({ nick: Schema.optional(Schema.NullOr(Schema.String)) })),
	/** Present when a webhook posted the message; `author.bot` is not always set for those. */
	webhook_id: Schema.optional(Schema.String),
})
export const decodeMessageCreate = Schema.decodeUnknownOption(MessageCreate)

export const InteractionCreate = Schema.Struct({
	id: Schema.String,
	token: Schema.String,
	type: Schema.Number,
	guild_id: Schema.optional(Schema.String),
	channel_id: Schema.optional(Schema.String),
	member: Schema.optional(
		Schema.Struct({
			user: User,
			nick: Schema.optional(Schema.NullOr(Schema.String)),
			roles: Schema.Array(Schema.String),
			/**
			 * The member's effective permissions in this channel, as a decimal string —
			 * permissions are serialized as strings from API v8 on because the bitfield
			 * outgrew 53 bits.
			 */
			permissions: Schema.optional(Schema.String),
		}),
	),
	message: Schema.optional(Schema.Struct({ id: Schema.String })),
	data: Schema.optional(
		Schema.Struct({
			custom_id: Schema.optional(Schema.String),
			component_type: Schema.optional(Schema.Number),
		}),
	),
})
export const decodeInteractionCreate = Schema.decodeUnknownOption(InteractionCreate)

export const GuildDelete = Schema.Struct({
	id: Schema.String,
	/**
	 * `true` while the guild is merely unreachable. Discord is explicit that the
	 * bot was removed only when the field is ABSENT, so a missing key and `false`
	 * are the removal and `true` is an outage to ride out.
	 */
	unavailable: Schema.optional(Schema.Boolean),
})
export const decodeGuildDelete = Schema.decodeUnknownOption(GuildDelete)

/** `MANAGE_GUILD` (`1 << 5`) and `ADMINISTRATOR` (`1 << 3`), the two that make someone an admin here. */
export const MANAGE_GUILD = 1n << 5n
export const ADMINISTRATOR = 1n << 3n
