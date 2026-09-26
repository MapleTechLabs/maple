/**
 * What all three halves of this connector agree on: where Slack is, what its secrets are called,
 * and what the app asks a workspace for.
 *
 * Its own module for the same reason `./id.ts` is: the install flow, the webhook ingress and the
 * outbound transport all need these, and none of them should have to import another to get them.
 *
 * Checked against Slack's current documentation (see `README.md` for the page behind each fact).
 */

/** Every Web API method is a path under this base, called with an ordinary form or JSON body. */
export const API_BASE = "https://slack.com/api"

export const API_HOST = "slack.com"

/** The OAuth v2 consent screen a workspace admin is sent to. Not under `/api`. */
export const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"

export const TOKEN_URL = `${API_BASE}/oauth.v2.access`

export const POST_MESSAGE_URL = `${API_BASE}/chat.postMessage`

export const POST_EPHEMERAL_URL = `${API_BASE}/chat.postEphemeral`

export const UPDATE_MESSAGE_URL = `${API_BASE}/chat.update`

/** What a channel holds. Answers newest first, which is the order the history contract asks for. */
export const CHANNEL_HISTORY_URL = `${API_BASE}/conversations.history`

/** What a thread holds. Addressed by the PARENT message's `ts`, which is the thread's own id. */
export const THREAD_REPLIES_URL = `${API_BASE}/conversations.replies`

/** The channels a workspace has, for picking where an alert goes. Query-string arguments only. */
export const CONVERSATIONS_LIST_URL = `${API_BASE}/conversations.list`

/**
 * The application's OAuth credentials, named in the install half's `requiredConfig`.
 *
 * The client id is not a secret — it rides the authorize URL the browser opens — which is why
 * `ConnectorConfigKey` carries that as a flag rather than assuming it.
 */
export const CLIENT_ID_CONFIG = "MAPLE_SLACK_CLIENT_ID"

export const CLIENT_SECRET_CONFIG = "MAPLE_SLACK_CLIENT_SECRET"

/**
 * The app's Signing Secret, named in the ingress half's `requiredConfig`.
 *
 * A different Worker resolves this than resolves the OAuth credentials: verifying a webhook is the
 * bot's job and installing is the dashboard's, so neither holds the other's secret. Every
 * deployment of this app shares one signing secret — it belongs to the Slack app, not to a
 * workspace — which is what lets a pure ingress function verify a request with configuration
 * alone.
 */
export const SIGNING_SECRET_CONFIG = "MAPLE_SLACK_SIGNING_SECRET"

/**
 * The bot scopes the install asks for, in the order Slack's app manifest lists them.
 *
 *   app_mentions:read   receive `app_mention` — the only event that starts a turn
 *   chat:write          post and edit the answer
 *   chat:write.public   post an alert to a public channel the bot was never invited to
 *   channels:history    read replies in a public channel's threads
 *   groups:history      …in a private channel's
 *   im:history          …in a direct message
 *   mpim:history        …in a group direct message
 *   channels:read       list public channels, to pick where an alert goes
 *   groups:read         …and the private channels the bot is in
 *
 * A workspace installed before the last three were added holds a token without them. It keeps
 * answering mentions, but listing channels answers `missing_scope` and an alert to a channel the
 * bot is not in answers `not_in_channel` — both reported as "reinstall to grant access", because
 * reinstalling is the only way a token gains a scope.
 *
 * The four history scopes are what deliver `message` events at all, and a thread follow-up is a
 * `message` event: without them the bot can be addressed once and never hears the rest of the
 * conversation it started.
 *
 * Deliberately NOT requested:
 *
 *   users:read     the only way to learn whether a clicker administers the workspace. Slack's
 *                  interaction payload carries no membership facts at all (see `events.ts`), so
 *                  this scope would buy one extra API call per button press for a fact Maple does
 *                  not yet act on. Adding it is a scope change every installed workspace has to
 *                  re-approve, so it waits until there is something to gate.
 *   reactions:write  nothing reacts. The bot answers in a thread, which is the acknowledgement.
 */
export const BOT_SCOPES: ReadonlyArray<string> = [
	"app_mentions:read",
	"chat:write",
	"chat:write.public",
	"channels:history",
	"groups:history",
	"im:history",
	"mpim:history",
	"channels:read",
	"groups:read",
]

/** Slack's request-signing version prefix. One value has ever existed; it is `v0`. */
export const SIGNATURE_VERSION = "v0"

export const SIGNATURE_HEADER = "x-slack-signature"

export const TIMESTAMP_HEADER = "x-slack-request-timestamp"

/**
 * Present when Slack is REDELIVERING an event it thinks was not acknowledged.
 *
 * `x-slack-retry-reason` rides with it and is not read: a retry is dropped whatever its reason.
 */
export const RETRY_HEADER = "x-slack-retry-num"

/**
 * How far a request's timestamp may sit from now, in seconds.
 *
 * Slack's own replay guidance: reject anything more than five minutes out. Both directions —
 * a timestamp in the future is a clock that cannot be trusted to have ever been in the past.
 */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300
