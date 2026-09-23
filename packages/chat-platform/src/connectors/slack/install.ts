import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	ChatInstallFailed,
	ChatSettingsRejected,
	requireConfig,
	type ChatConnectorInstall,
	type ChatInstallCallback,
	type ChatInstallResult,
	type ChatInstallStart,
	type ChatWorkspaceSettings,
} from "../../install"
import { AUTHORIZE_URL, BOT_SCOPES, CLIENT_ID_CONFIG, CLIENT_SECRET_CONFIG, TOKEN_URL } from "./api"
import { encodeSlackCredentials } from "./credentials"
import { SLACK_CONNECTOR_ID } from "./id"
import { decodeTokenResponse } from "./payloads"

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
		scope: BOT_SCOPES.join(","),
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
const complete = Effect.fnUntraced(function* (input: ChatInstallCallback) {
	const denied = input.params.get("error")
	if (denied !== null) {
		return yield* Effect.fail(installFailed(`Slack rejected the authorization: ${denied}`))
	}
	const code = input.params.get("code")
	if (code === null) {
		return yield* Effect.fail(installFailed("Slack's callback carried no authorization code"))
	}
	const clientId = yield* requireConfig(input.config, SLACK_CONNECTOR_ID, CLIENT_ID_CONFIG)
	const clientSecret = yield* requireConfig(input.config, SLACK_CONNECTOR_ID, CLIENT_SECRET_CONFIG)

	const httpClient = yield* HttpClient.HttpClient
	const request = HttpClientRequest.post(TOKEN_URL, { headers: { accept: "application/json" } }).pipe(
		// Slack's token endpoint takes the client credentials in the form body and reads only
		// `application/x-www-form-urlencoded`.
		HttpClientRequest.bodyUrlParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: input.redirectUri,
		}),
	)
	const response = yield* httpClient
		.execute(request)
		.pipe(Effect.mapError((error) => installFailed(`Slack token exchange failed: ${error.message}`)))
	if (response.status < 200 || response.status >= 300) {
		return yield* Effect.fail(installFailed(`Slack token exchange failed with HTTP ${response.status}`))
	}
	const json = yield* response.json.pipe(
		Effect.mapError(() => installFailed("Slack returned a non-JSON token response")),
	)
	const decoded = yield* decodeTokenResponse(json).pipe(
		Effect.mapError(() => installFailed("Slack returned an unexpected token response")),
	)
	// Slack reports a refused exchange as HTTP 200 with `ok: false`, so the status said nothing.
	if (!decoded.ok) {
		return yield* Effect.fail(
			installFailed(`Slack refused the token exchange: ${decoded.error ?? "unknown"}`),
		)
	}
	if (decoded.is_enterprise_install === true) {
		return yield* Effect.fail(
			installFailed(
				"This is an enterprise-wide Slack install, which Maple cannot link yet — install the app into a single workspace instead",
			),
		)
	}
	const team = decoded.team ?? null
	const teamId = team?.id
	const botToken = decoded.access_token
	const botUserId = decoded.bot_user_id
	if (teamId === undefined || botToken === undefined || botUserId === undefined) {
		return yield* Effect.fail(installFailed("Slack's token response named no workspace and bot user"))
	}
	return {
		externalWorkspaceId: teamId,
		name: team?.name ?? teamId,
		// The workspace's own token. The host seals it; only this connector's outbound half reads it
		// back, and it is never anywhere else — not on a span, not in a log, not in an error.
		credentials: encodeSlackCredentials({ bot_token: botToken, bot_user_id: botUserId }),
	} satisfies ChatInstallResult
})

/**
 * No settings. Slack's interaction payload carries no membership facts, so the approver role the
 * other connector offers has nothing to check against here; an empty record is stored and a posted
 * key is reported rather than silently dropped.
 */
const decodeSettings = (
	input: ChatWorkspaceSettings,
): Effect.Effect<ChatWorkspaceSettings, ChatSettingsRejected> =>
	Object.keys(input).length === 0
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
	decodeSettings,
}
