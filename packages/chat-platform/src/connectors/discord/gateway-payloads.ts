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
 * `MESSAGE_CONTENT` (`1 << 15`), which is privileged and **required**.
 *
 * Without it `content` arrives empty over the gateway AND over the REST API for
 * everything except messages the app sent, DMs with it, and messages in which
 * it is mentioned — which leaves out both halves of what the bot reads: the
 * conversation around a mention, and a follow-up in a thread it opened. The
 * application must have it enabled in the developer portal; identifying without
 * that grant is close code 4014, which is fatal. See this directory's README.
 */
export const MESSAGE_CONTENT_INTENT = 1 << 15

/**
 * `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT` (`1 << 0 | 1 << 9 | 1 << 15`).
 *
 * `GUILDS` is what delivers `GUILD_DELETE`, which is how the bot learns it was
 * removed from a server. `GUILD_MESSAGES` delivers `MESSAGE_CREATE`, in threads
 * as well as in channels. `MESSAGE_CONTENT` is what puts anything in them.
 *
 * `INTERACTION_CREATE` is not gated by any intent, so approval buttons work
 * whatever is in this set.
 */
export const INTENTS = (1 << 0) | (1 << 9) | MESSAGE_CONTENT_INTENT

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
 * which for this connector means exactly one thing and has exactly one fix.
 */
export const FATAL_CLOSE_HINTS: ReadonlyMap<number, string> = new Map([
	[
		4014,
		"enable Message Content Intent for this application in the Discord developer portal (Bot → Privileged Gateway Intents)",
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

/**
 * Who wrote something, as far as this connector reads it. Exported because the REST half reads the
 * same Discord user out of a message it fetched, and two models of one wire object drift.
 */
export const User = Schema.Struct({
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
	 * Empty on a message that carries no text of its own — an embed, an
	 * attachment, a system notice — and on every message at all if the
	 * application has lost the MESSAGE_CONTENT grant.
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
		// Who clicked, and nothing about what they may do: Maple decides that from whether they
		// linked this account, never from what Discord says they can do in the server.
		Schema.Struct({
			user: User,
			nick: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
