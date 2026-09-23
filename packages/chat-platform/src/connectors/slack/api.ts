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

export const UPDATE_MESSAGE_URL = `${API_BASE}/chat.update`

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
 *   channels:history    read replies in a public channel's threads
 *   groups:history      …in a private channel's
 *   im:history          …in a direct message
 *   mpim:history        …in a group direct message
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
	"channels:history",
	"groups:history",
	"im:history",
	"mpim:history",
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
