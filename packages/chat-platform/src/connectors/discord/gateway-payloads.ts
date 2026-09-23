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
import { MESSAGE_CONTENT_CONFIG } from "./api.ts"

/** `wss://gateway.discord.gg/?v=10&encoding=json` — JSON, uncompressed, single shard. */
export const GATEWAY_QUERY = "?v=10&encoding=json"
export const GATEWAY_URL = `wss://gateway.discord.gg/${GATEWAY_QUERY}`

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
 * removed from a server. `GUILD_MESSAGES` delivers `MESSAGE_CREATE`, in threads
 * as well as in channels.
 *
 * `INTERACTION_CREATE` is not gated by any intent, so approval buttons work on
 * this set too.
 */
export const INTENTS = (1 << 0) | (1 << 9)

/**
 * `MESSAGE_CONTENT` (`1 << 15`), added only when the deployment asks for it.
 *
 * It is privileged, and the documented exceptions cover the mention-only
 * product exactly: content reaches the app for messages it sent, DMs with it,
 * and **messages in which it is mentioned**. Everything else — a follow-up in a
 * thread Maple opened, the messages around a mention that give it context —
 * arrives with `content` empty, over the gateway AND over the REST API.
 *
 * So it is off by default and turned on by setting {@link MESSAGE_CONTENT_CONFIG}
 * on a deployment whose Discord application has the intent enabled in the
 * developer portal. Identifying with an intent the application has not been
 * granted is close code 4014, which is fatal — see this directory's README.
 */
export const MESSAGE_CONTENT_INTENT = 1 << 15

/** The identify intents for this deployment. */
export const gatewayIntents = (messageContent: boolean): number =>
	messageContent ? INTENTS | MESSAGE_CONTENT_INTENT : INTENTS

/** Interaction types (`type` on an `INTERACTION_CREATE`). Only the component click matters here. */
export const INTERACTION_MESSAGE_COMPONENT = 3

/** Interaction callback type 6: acknowledge the click, leave the message as it is. */
export const CALLBACK_DEFERRED_UPDATE_MESSAGE = 6

/**
 * The close codes whose `Reconnect` column Discord marks `false`, and only
 * those.
 *
 * Every one of them is configuration rather than weather: a rejected token, a
 * shard count this connector does not use, an API version that no longer
 * exists, an intent the application has not been granted. Reconnecting cannot
 * fix any of them, so the answer is one reported failure instead of a loop.
 *
 * The client-error codes `4001`, `4002`, `4003` and `4005` are deliberately NOT
 * here, however much they read like bugs: Discord marks all four reconnectable,
 * and `4003` explicitly covers a session it invalidated on its own side. Taking
 * them as fatal would have put the bot down for hours over something the next
 * connection fixes — the table in `topics/opcodes-and-status-codes` is the
 * source, not the prose elsewhere that summarises it.
 */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014])

/**
 * What a fatal code actually means, for the one line an operator reads.
 *
 * 4014 is the one worth spelling out: it is what Discord answers when the
 * identify asks for a privileged intent the application has not been granted,
 * and it is the failure mode of {@link MESSAGE_CONTENT_CONFIG} being set on a
 * deployment whose application does not have the intent enabled.
 */
export const FATAL_CLOSE_HINTS: ReadonlyMap<number, string> = new Map([
	[
		4014,
		`a privileged intent this application has not been granted — enable Message Content in the Bot tab, or unset ${MESSAGE_CONTENT_CONFIG}`,
	],
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
	d: Schema.optionalKey(Schema.Unknown),
	s: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	t: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
	global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	bot: Schema.optionalKey(Schema.Boolean),
})

export const MessageCreate = Schema.Struct({
	id: Schema.String,
	channel_id: Schema.String,
	/** Absent on a DM. This connector requests no DM intent, so a message without it is dropped. */
	guild_id: Schema.optionalKey(Schema.String),
	author: User,
	/**
	 * Empty unless the application holds the MESSAGE_CONTENT intent or the
	 * message qualifies under one of its exceptions — for this bot, unless it
	 * was mentioned.
	 */
	content: Schema.String,
	mentions: Schema.Array(User),
	member: Schema.optionalKey(Schema.Struct({ nick: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	/** Present when a webhook posted the message; `author.bot` is not always set for those. */
	webhook_id: Schema.optionalKey(Schema.String),
})
export const decodeMessageCreate = Schema.decodeUnknownOption(MessageCreate)

export const InteractionCreate = Schema.Struct({
	id: Schema.String,
	token: Schema.String,
	type: Schema.Number,
	guild_id: Schema.optionalKey(Schema.String),
	channel_id: Schema.optionalKey(Schema.String),
	member: Schema.optionalKey(
		Schema.Struct({
			user: User,
			nick: Schema.optionalKey(Schema.NullOr(Schema.String)),
			roles: Schema.Array(Schema.String),
			/**
			 * The member's effective permissions in this channel, as a decimal string —
			 * permissions are serialized as strings from API v8 on because the bitfield
			 * outgrew 53 bits.
			 */
			permissions: Schema.optionalKey(Schema.String),
		}),
	),
	message: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
	data: Schema.optionalKey(
		Schema.Struct({
			custom_id: Schema.optionalKey(Schema.String),
			component_type: Schema.optionalKey(Schema.Number),
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
	unavailable: Schema.optionalKey(Schema.Boolean),
})
export const decodeGuildDelete = Schema.decodeUnknownOption(GuildDelete)

/** `MANAGE_GUILD` (`1 << 5`) and `ADMINISTRATOR` (`1 << 3`), the two that make someone an admin here. */
export const MANAGE_GUILD = 1n << 5n
export const ADMINISTRATOR = 1n << 3n
