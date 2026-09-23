/**
 * Slack's wire vocabulary, as far as this connector reads it.
 *
 * Every schema is deliberately partial: Slack's payloads are large, most of each one is
 * irrelevant, and Effect Schema drops the keys a struct does not name — so a field added upstream
 * cannot break decoding here.
 *
 * Verified against Slack's Events API, event reference and interaction-payload documentation; the
 * pages behind each are listed in this directory's README.
 */
import { Option, Schema } from "effect"

/** Sent once, when a request URL is first saved in the app's configuration. */
export const UrlVerification = Schema.Struct({
	type: Schema.Literal("url_verification"),
	challenge: Schema.String,
})

/**
 * Who Slack says this event was delivered on behalf of.
 *
 * This is where the bot's own user id comes from. It is per event and per workspace, so the
 * connector never has to store it or be told it — which matters, because ingress is a pure
 * function over the request and the deployment's configuration, and the bot user id is neither.
 */
const Authorization = Schema.Struct({
	user_id: Schema.optionalKey(Schema.String),
	is_bot: Schema.optionalKey(Schema.Boolean),
})

/** The `app_mention` and `message.*` fields this connector reads. */
const EventBody = Schema.Struct({
	type: Schema.String,
	/** Absent on the subtypes this connector drops; a message with no channel is not answerable. */
	channel: Schema.optionalKey(Schema.String),
	user: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	ts: Schema.optionalKey(Schema.String),
	/** Present when the message is a reply; the parent's `ts`, which names the thread. */
	thread_ts: Schema.optionalKey(Schema.String),
	/** `message_changed`, `channel_join`, `bot_message`, … — anything but a plain message. */
	subtype: Schema.optionalKey(Schema.String),
	/** Set on a message a bot posted, including this bot's own answers. */
	bot_id: Schema.optionalKey(Schema.String),
})
export type SlackEventBody = Schema.Schema.Type<typeof EventBody>

/** The envelope every delivered event arrives in. */
export const EventCallback = Schema.Struct({
	type: Schema.Literal("event_callback"),
	team_id: Schema.String,
	event_id: Schema.optionalKey(Schema.String),
	event: EventBody,
	authorizations: Schema.optionalKey(Schema.Array(Authorization)),
})
export type SlackEventCallback = Schema.Schema.Type<typeof EventCallback>

/** Either of the two things a POST to the events URL can be. Anything else decodes to neither. */
export const EventRequest = Schema.Union([UrlVerification, EventCallback])

/**
 * Both decoders take the RAW JSON text, not a parsed object.
 *
 * `JSON.parse` throws, and a throw is invisible to the type system — so the parse lives inside the
 * schema, where a body that is not JSON and a body that is not this payload are the same `None`.
 * They mean the same thing at the ingress anyway: Slack sent something with no mapping here.
 */
export const decodeEventRequest = Schema.decodeUnknownOption(Schema.fromJsonString(EventRequest))

/**
 * A `block_actions` payload, as the interactivity URL receives it (form-encoded under `payload=`).
 *
 * `user` carries `id`, `username`, `name` and `team_id` and NOTHING about membership: no roles, no
 * `is_admin`, no `is_owner`. That is a Slack fact, not an omission here — see `events.ts` for what
 * this connector reports because of it.
 */
export const BlockActions = Schema.Struct({
	type: Schema.Literal("block_actions"),
	team: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
	user: Schema.Struct({
		id: Schema.String,
		username: Schema.optionalKey(Schema.String),
		name: Schema.optionalKey(Schema.String),
		team_id: Schema.optionalKey(Schema.String),
	}),
	channel: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
	container: Schema.optionalKey(
		Schema.Struct({
			channel_id: Schema.optionalKey(Schema.String),
			message_ts: Schema.optionalKey(Schema.String),
		}),
	),
	message: Schema.optionalKey(Schema.Struct({ ts: Schema.optionalKey(Schema.String) })),
	actions: Schema.Array(
		Schema.Struct({
			action_id: Schema.optionalKey(Schema.String),
			value: Schema.optionalKey(Schema.String),
		}),
	),
})
export type SlackBlockActions = Schema.Schema.Type<typeof BlockActions>

export const decodeBlockActions = Schema.decodeUnknownOption(Schema.fromJsonString(BlockActions))

/**
 * The token response, for an authorization that installed the bot into ONE workspace.
 *
 * `team` is optional because Slack answers with `"team": null` for an enterprise-wide install, and
 * `is_enterprise_install` is read so that case is refused by name rather than as "no team".
 */
export const TokenResponse = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
	access_token: Schema.optionalKey(Schema.String),
	is_enterprise_install: Schema.optionalKey(Schema.Boolean),
	team: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				id: Schema.optionalKey(Schema.String),
				name: Schema.optionalKey(Schema.String),
			}),
		),
	),
})

export const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)

/**
 * What a Web API call answers with.
 *
 * Slack reports most failures as HTTP 200 with `ok: false`, so the status code is not the answer —
 * a transport that read only the status would file every revoked token as a success.
 */
export const ApiResult = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
	channel: Schema.optionalKey(Schema.String),
	ts: Schema.optionalKey(Schema.String),
})

export const decodeApiResult = Schema.decodeUnknownEffect(ApiResult)

/** The bot's own user id for this delivery, where Slack named it. */
export const botUserIdOf = (callback: SlackEventCallback): Option.Option<string> =>
	Option.fromNullishOr(
		callback.authorizations?.find((authorization) => authorization.is_bot === true)?.user_id,
	)
