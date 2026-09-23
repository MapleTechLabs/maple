/**
 * Discord's half of the identity contract: prove which Discord account a person controls.
 *
 * Checked against Discord's OAuth2 documentation for API v10: the authorize page is
 * `https://discord.com/oauth2/authorize` with `response_type=code`, the token endpoint is
 * `POST /api/v10/oauth2/token` taking `application/x-www-form-urlencoded`, and the account behind
 * an access token is `GET /api/v10/users/@me` with `Authorization: Bearer <token>`.
 *
 * `identify` is the whole scope, and it is the narrowest one Discord has: it returns the user
 * object without their email and grants nothing else. The token is used for that single request
 * and dropped — Maple never acts on Discord as the person, only as the bot.
 */
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChatIdentityFailed, type ChatConnectorIdentity } from "../../identity"
import { requireConfig, type ChatInstallCallback, type ChatInstallStart } from "../../install"
import { API_BASE, AUTHORIZE_URL, CLIENT_ID_CONFIG, CLIENT_SECRET_CONFIG, TOKEN_URL } from "./api"
import { DISCORD_CONNECTOR_ID } from "./id"

/**
 * Only `identify`, and deliberately not `guilds`: which servers somebody is in is not Maple's
 * business, and the bot already knows which server a click came from.
 */
const IDENTIFY_SCOPE = "identify"

const AccessToken = Schema.Struct({ access_token: Schema.String })
const decodeAccessToken = Schema.decodeUnknownEffect(AccessToken)

/**
 * The account behind the token. `global_name` is Discord's current display name and is absent on
 * accounts that never set one, which is what `username` is for.
 */
const CurrentUser = Schema.Struct({
	id: Schema.String,
	username: Schema.optionalKey(Schema.String),
	global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const decodeCurrentUser = Schema.decodeUnknownEffect(CurrentUser)

const identityFailed = (message: string) =>
	new ChatIdentityFailed({ connector: DISCORD_CONNECTOR_ID, message })

export const discordIdentityAuthorizeUrl = (
	clientId: string,
	input: { state: string; redirectUri: string },
): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		scope: IDENTIFY_SCOPE,
		response_type: "code",
		redirect_uri: input.redirectUri,
		state: input.state,
	})
	return `${AUTHORIZE_URL}?${params.toString()}`
}

const authorizeUrl = (input: ChatInstallStart) =>
	Effect.map(requireConfig(input.config, DISCORD_CONNECTOR_ID, CLIENT_ID_CONFIG), (clientId) =>
		discordIdentityAuthorizeUrl(clientId, { state: input.state, redirectUri: input.redirectUri }),
	)

/**
 * Exchange the callback's code for the Discord account it was issued to.
 *
 * The id comes from `/users/@me` asked with the grant, never from a callback parameter: the
 * parameters belong to whoever opened the URL, and this is the value a click is later matched
 * against.
 */
const complete = Effect.fnUntraced(function* (input: ChatInstallCallback) {
	const denied = input.params.get("error")
	if (denied !== null) {
		return yield* Effect.fail(identityFailed(`Discord rejected the authorization: ${denied}`))
	}
	const code = input.params.get("code")
	if (code === null) {
		return yield* Effect.fail(identityFailed("Discord's callback carried no authorization code"))
	}
	const clientId = yield* requireConfig(input.config, DISCORD_CONNECTOR_ID, CLIENT_ID_CONFIG)
	const clientSecret = yield* requireConfig(input.config, DISCORD_CONNECTOR_ID, CLIENT_SECRET_CONFIG)
	const httpClient = yield* HttpClient.HttpClient

	const tokenResponse = yield* httpClient
		.execute(
			HttpClientRequest.post(TOKEN_URL, { headers: { accept: "application/json" } }).pipe(
				// Same form-encoded grant the install half runs, over the same OAuth application.
				HttpClientRequest.bodyUrlParams({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "authorization_code",
					code,
					redirect_uri: input.redirectUri,
				}),
			),
		)
		.pipe(Effect.mapError((error) => identityFailed(`Discord token exchange failed: ${error.message}`)))
	if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
		return yield* Effect.fail(
			identityFailed(`Discord token exchange failed with HTTP ${tokenResponse.status}`),
		)
	}
	const tokenJson = yield* tokenResponse.json.pipe(
		Effect.mapError(() => identityFailed("Discord returned a non-JSON token response")),
	)
	const token = yield* decodeAccessToken(tokenJson).pipe(
		Effect.mapError(() => identityFailed("Discord returned an unexpected token response")),
	)

	const userResponse = yield* httpClient
		.execute(
			HttpClientRequest.get(`${API_BASE}/users/@me`, {
				headers: { accept: "application/json", authorization: `Bearer ${token.access_token}` },
			}),
		)
		.pipe(Effect.mapError((error) => identityFailed(`Discord user lookup failed: ${error.message}`)))
	if (userResponse.status < 200 || userResponse.status >= 300) {
		return yield* Effect.fail(
			identityFailed(`Discord user lookup failed with HTTP ${userResponse.status}`),
		)
	}
	const userJson = yield* userResponse.json.pipe(
		Effect.mapError(() => identityFailed("Discord returned a non-JSON user response")),
	)
	const user = yield* decodeCurrentUser(userJson).pipe(
		Effect.mapError(() => identityFailed("Discord returned an unexpected user response")),
	)
	const displayName = user.global_name ?? user.username
	return {
		externalUserId: user.id,
		...(displayName === undefined || displayName === null ? undefined : { displayName }),
	}
})

export const discordIdentity: ChatConnectorIdentity = { authorizeUrl, complete }
