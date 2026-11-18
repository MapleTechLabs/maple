import { Effect, Array as Arr, Option, Record as Rec, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	ChatInstallFailed,
	ChatRevokeFailed,
	ChatSettingsRejected,
	requireConfig,
	type ChatConnectorInstall,
	type ChatInstallCallback,
	type ChatInstallResult,
	type ChatInstallRevocation,
	type ChatInstallStart,
	type ChatWorkspaceSettings,
} from "../../install"
import { WORKSPACE_CREDENTIALS } from "../../outbound"
import {
	API_HOST,
	AUTH_REVOKE_URL,
	AUTHORIZE_URL,
	BOT_SCOPES,
	CLIENT_ID_CONFIG,
	CLIENT_SECRET_CONFIG,
	TOKEN_URL,
} from "./api"
import { decodeSlackCredentials, encodeSlackCredentials } from "./credentials"
import { SLACK_CONNECTOR_ID } from "./id"
import { decodeApiResult, decodeTokenResponse } from "./payloads"

/**
 * The consent screen. `scope` is the BOT scopes, comma separated; `user_scope` is deliberately
 * absent, so Slack issues no user token and Maple never holds an installer's identity — the bot is
 * an org-level actor, and a user token is a credential with nothing to spend it on.
 */
export const slackAuthorizeUrl = (
	clientId: string,
	input: { state: string; redirectUri: string },
): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		scope: Arr.join(BOT_SCOPES, ","),
		redirect_uri: input.redirectUri,
		state: input.state,
	})
	return `${AUTHORIZE_URL}?${params.toString()}`
}

const authorizeUrl = (input: ChatInstallStart) =>
	Effect.map(requireConfig(input.config, SLACK_CONNECTOR_ID, CLIENT_ID_CONFIG), (clientId) =>
		slackAuthorizeUrl(clientId, { state: input.state, redirectUri: input.redirectUri }),
	)

const installFailed = (message: string) => new ChatInstallFailed({ connector: SLACK_CONNECTOR_ID, message })

/**
 * Exchange the callback's code for the workspace it was issued against, and for the bot token that
 * workspace just minted.
 *
 * The team comes from the TOKEN RESPONSE, which Slack binds to the authorization code, never from
 * a callback query parameter — those belong to whoever opens the callback URL, and trusting one
 * would let an install be pointed at a workspace the authorization never covered.
 *
 * An enterprise-wide install is refused by name. Slack answers it with `team: null` and an
 * `enterprise` instead, and the token it issues spans every workspace in the org — so the
 * `(connector, external workspace id)` row this install writes would not match the `team_id` on any
 * event the bot then receives. Supporting it is a real feature (an org id as the workspace
 * identity, and an `authorizations` entry to resolve each event's team), not a missing branch.
 */
const exchangeCode = Effect.fn("Slack.request", { kind: "client" })(function* (input: {
	readonly clientId: string
	readonly clientSecret: string
	readonly code: string
	readonly redirectUri: string
}) {
	yield* Effect.annotateCurrentSpan({
		"peer.service": "slack",
		"http.request.method": "POST",
		"server.address": API_HOST,
		"url.template": "/api/oauth.v2.access",
	})
	const httpClient = yield* HttpClient.HttpClient
	const request = HttpClientRequest.post(TOKEN_URL, { headers: { accept: "application/json" } }).pipe(
		// Slack's token endpoint takes the client credentials in the form body and reads only
		// `application/x-www-form-urlencoded`. The body is never annotated on this span.
		HttpClientRequest.bodyUrlParams({
			client_id: input.clientId,
			client_secret: input.clientSecret,
			code: input.code,
			redirect_uri: input.redirectUri,
		}),
	)
	const response = yield* httpClient
		.execute(request)
		.pipe(Effect.mapError((error) => installFailed(`Slack token exchange failed: ${error.message}`)))
	yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
	if (response.status < 200 || response.status >= 300) {
		return yield* installFailed(`Slack token exchange failed with HTTP ${response.status}`)
	}
	const json = yield* response.json.pipe(
		Effect.mapError(() => installFailed("Slack returned a non-JSON token response")),
	)
	const decoded = yield* decodeTokenResponse(json).pipe(
		Effect.mapError(() => installFailed("Slack returned an unexpected token response")),
	)
	// Slack reports a refused exchange as HTTP 200 with `ok: false`, so the status said nothing.
	if (!decoded.ok) {
		const error = decoded.error ?? "unknown"
		yield* Effect.annotateCurrentSpan({ "error.type": error })
		return yield* installFailed(`Slack refused the token exchange: ${error}`)
	}
	return decoded
})

const complete = Effect.fnUntraced(function* (input: ChatInstallCallback) {
	const denied = input.params.get("error")
	if (denied !== null) {
		return yield* installFailed(`Slack rejected the authorization: ${denied}`)
	}
	const code = input.params.get("code")
	if (code === null) {
		return yield* installFailed("Slack's callback carried no authorization code")
	}
	const clientId = yield* requireConfig(input.config, SLACK_CONNECTOR_ID, CLIENT_ID_CONFIG)
	const clientSecret = yield* requireConfig(input.config, SLACK_CONNECTOR_ID, CLIENT_SECRET_CONFIG)

	const decoded = yield* exchangeCode({ clientId, clientSecret, code, redirectUri: input.redirectUri })
	if (decoded.is_enterprise_install === true) {
		return yield* installFailed(
			"This is an enterprise-wide Slack install, which Maple cannot link yet — install the app into a single workspace instead",
		)
	}
	const teamId = decoded.team?.id
	const botToken = decoded.access_token
	if (teamId === undefined || botToken === undefined) {
		return yield* installFailed("Slack's token response named no workspace and bot token")
	}
	return {
		externalWorkspaceId: teamId,
		name: decoded.team?.name ?? teamId,
		// The workspace's own token. The host seals it; only this connector's outbound half reads it
		// back, and it is never anywhere else — not on a span, not in a log, not in an error.
		credentials: encodeSlackCredentials({ bot_token: botToken }),
	} satisfies ChatInstallResult
})

const revokeFailed = (message: string) => new ChatRevokeFailed({ connector: SLACK_CONNECTOR_ID, message })

/**
 * `ok: false` answers that say the token is already dead. Not `invalid_auth`: Slack also answers
 * it for a mangled token or a disallowed IP, where the real token is still live.
 */
const ALREADY_REVOKED: ReadonlySet<string> = new Set(["token_revoked", "account_inactive"])

/** `auth.revoke` with the workspace's own bot token, as one client span. The token rides the header only. */
const revokeToken = Effect.fn("Slack.request", { kind: "client" })(function* (token: Redacted.Redacted) {
	yield* Effect.annotateCurrentSpan({
		"peer.service": "slack",
		"http.request.method": "POST",
		"server.address": API_HOST,
		"url.template": "/api/auth.revoke",
	})
	const httpClient = yield* HttpClient.HttpClient
	const response = yield* httpClient
		.execute(
			HttpClientRequest.post(AUTH_REVOKE_URL, {
				headers: { accept: "application/json", authorization: `Bearer ${Redacted.value(token)}` },
			}),
		)
		// The reason only: the request carries the token.
		.pipe(Effect.mapError((error) => revokeFailed(`Slack token revoke failed: ${error.reason._tag}`)))
	yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
	if (response.status < 200 || response.status >= 300) {
		return yield* revokeFailed(`Slack token revoke failed with HTTP ${response.status}`)
	}
	const json = yield* response.json.pipe(
		Effect.mapError(() => revokeFailed("Slack returned a non-JSON revoke response")),
	)
	const result = yield* decodeApiResult(json).pipe(
		Effect.mapError(() => revokeFailed("Slack returned an unexpected revoke response")),
	)
	// Slack reports a refusal as HTTP 200 with `ok: false`, so the status said nothing.
	if (result.ok) return
	const error = result.error ?? "unknown"
	yield* Effect.annotateCurrentSpan({ "error.type": error })
	if (!ALREADY_REVOKED.has(error)) return yield* revokeFailed(`Slack refused the token revoke: ${error}`)
})

/**
 * Revoke the bot token the install minted. A workspace with no readable token fails before the
 * span opens: that is Maple's state, and a call that was never made is no edge on the service map.
 */
const revoke = (input: ChatInstallRevocation) =>
	Option.match(decodeSlackCredentials(input.credentials.get(WORKSPACE_CREDENTIALS)), {
		onNone: () => Effect.fail(revokeFailed("This Slack workspace holds no bot token to revoke")),
		onSome: (credentials) => revokeToken(Redacted.make(credentials.bot_token)),
	})

/**
 * No settings. Slack's interaction payload carries no membership facts, so there is no approver
 * role to check against; an empty record is stored and a posted key is reported rather than
 * silently dropped.
 */
const decodeSettings = (
	input: ChatWorkspaceSettings,
): Effect.Effect<ChatWorkspaceSettings, ChatSettingsRejected> =>
	Rec.keys<string, string>(input).length === 0
		? Effect.succeed({})
		: Effect.fail(
				new ChatSettingsRejected({
					connector: SLACK_CONNECTOR_ID,
					message: "Slack carries no workspace settings yet",
				}),
			)

export const slackInstall: ChatConnectorInstall = {
	// The client id is public — it rides the authorize URL the browser opens.
	requiredConfig: [
		{ name: CLIENT_ID_CONFIG, secret: false },
		{ name: CLIENT_SECRET_CONFIG, secret: true },
	],
	authorizeUrl,
	complete,
	revoke,
	decodeSettings,
}
