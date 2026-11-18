import { Effect, Record as Rec, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	ChatInstallFailed,
	ChatRevokeFailed,
	ChatSettingsRejected,
	requireConfig,
	type ChatConnectorInstall,
	type ChatInstallCallback,
	type ChatInstallRevocation,
	type ChatInstallStart,
	type ChatWorkspaceSettings,
} from "../../install"
import {
	API_BASE,
	API_HOST,
	AUTHORIZE_URL,
	BOT_TOKEN_CONFIG,
	CLIENT_ID_CONFIG,
	CLIENT_SECRET_CONFIG,
} from "./api"
import { exchangeCode } from "./exchange"
import { DISCORD_CONNECTOR_ID } from "./id"

/**
 * The bot permissions requested when the app is added to a guild, as Discord's
 * variable-length permission integer. Each bit is something the bot does:
 *
 *   VIEW_CHANNEL (1 << 10)             read the channels it is invited to
 *   SEND_MESSAGES (1 << 11)            answer in a channel
 *   EMBED_LINKS (1 << 14)              render its answers as embeds
 *   READ_MESSAGE_HISTORY (1 << 16)     read the messages a thread already holds
 *   ADD_REACTIONS (1 << 6)             acknowledge a request it has picked up
 *   CREATE_PUBLIC_THREADS (1 << 35)    keep an investigation out of the channel
 *   SEND_MESSAGES_IN_THREADS (1 << 38) continue in the thread it opened
 *
 * Nothing here is an elevated permission, so adding the bot never prompts for
 * two-factor authentication, and the set contains no member, role, channel or
 * moderation power: the worst a compromised bot token can do in a guild is post.
 */
const BOT_PERMISSIONS = "309237730368"

/**
 * Only `bot` is requested. `applications.commands` comes with it, and anything
 * beyond the two would make Discord treat this as a user authorization — a user
 * identity Maple has no use for, since the bot is an org-level actor.
 */
const BOT_SCOPE = "bot"

/**
 * Discord snowflake: an unsigned 64-bit id as a decimal string. Every id Discord
 * mints is one, and checking it here means a value that is not an id fails where
 * it is diagnosable rather than one the API silently never matches.
 */
const Snowflake = Schema.String.check(Schema.isPattern(/^\d{17,20}$/u))

/**
 * The extended token response Discord returns for a `bot` authorization: the
 * guild the bot was added to, bound to the authorization code. Only `guild` is
 * read — the user's access and refresh tokens are deliberately not stored, since
 * the bot acts with its own token and never as the installer.
 */
const TokenResponse = Schema.Struct({
	guild: Schema.optionalKey(Schema.Struct({ id: Snowflake, name: Schema.optionalKey(Schema.String) })),
})
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)

/**
 * The install URL. `state` is the host's single-use nonce; `response_type=code`
 * plus `redirect_uri` is what makes Discord run the full authorization-code
 * grant, whose token response names the guild.
 *
 * `guild_id` and `disable_guild_select` are deliberately absent: Discord
 * documents the guild picker's `guild_id` as a hint only, so pre-selecting one
 * would suggest a guarantee the flow does not have.
 */
export const discordAuthorizeUrl = (
	clientId: string,
	input: { state: string; redirectUri: string },
): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		scope: BOT_SCOPE,
		permissions: BOT_PERMISSIONS,
		response_type: "code",
		redirect_uri: input.redirectUri,
		state: input.state,
	})
	return `${AUTHORIZE_URL}?${params.toString()}`
}

const authorizeUrl = (input: ChatInstallStart) =>
	Effect.map(requireConfig(input.config, DISCORD_CONNECTOR_ID, CLIENT_ID_CONFIG), (clientId) =>
		discordAuthorizeUrl(clientId, { state: input.state, redirectUri: input.redirectUri }),
	)

const installFailed = (message: string) => new ChatInstallFailed({ connector: DISCORD_CONNECTOR_ID, message })

/**
 * Exchange the callback's code for the guild it was issued against.
 *
 * The guild id comes from the TOKEN RESPONSE, never from the callback's
 * `guild_id` parameter: that parameter is documented as a hint, is enumerable,
 * and is under the control of whoever opens the callback URL, so trusting it
 * would let an install be pointed at a guild the authorization never covered.
 * Discord also requires the authorizing member to hold MANAGE_GUILD, so the
 * code is proof that a manager of *that* guild approved this install.
 */
const complete = Effect.fnUntraced(function* (input: ChatInstallCallback) {
	const json = yield* exchangeCode(input, installFailed)
	const decoded = yield* decodeTokenResponse(json).pipe(
		Effect.mapError(() => installFailed("Discord returned an unexpected token response")),
	)
	const guild = decoded.guild
	if (guild === undefined) {
		// No guild means the authorization was not a bot install (or the app's
		// install settings overrode the requested scope) — there is nothing to link.
		return yield* installFailed("Discord's authorization did not add the bot to a server")
	}
	return { externalWorkspaceId: guild.id, name: guild.name ?? guild.id }
})

const revokeFailed = (message: string) => new ChatRevokeFailed({ connector: DISCORD_CONNECTOR_ID, message })

const isSnowflake = Schema.is(Snowflake)

/** `DELETE /users/@me/guilds/{guild.id}` as the bot, as one client span. The token rides the header only. */
const leaveGuild = Effect.fn("Discord.request", { kind: "client" })(function* (
	token: Redacted.Redacted,
	guildId: string,
) {
	yield* Effect.annotateCurrentSpan({
		"peer.service": "discord",
		"http.request.method": "DELETE",
		"server.address": API_HOST,
		"url.template": "/users/@me/guilds/{guild.id}",
	})
	const httpClient = yield* HttpClient.HttpClient
	const response = yield* httpClient
		.execute(
			HttpClientRequest.delete(`${API_BASE}/users/@me/guilds/${guildId}`, {
				headers: { authorization: `Bot ${Redacted.value(token)}` },
			}),
		)
		// The reason only: the request carries the token.
		.pipe(
			Effect.mapError((error) =>
				revokeFailed(`Leaving the Discord server failed: ${error.reason._tag}`),
			),
		)
	yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
	// 404: the bot is in no such server, which is the state this call is for.
	if (response.status === 404) return
	if (response.status < 200 || response.status >= 300) {
		return yield* revokeFailed(`Leaving the Discord server failed with HTTP ${response.status}`)
	}
})

/**
 * Take the bot out of the server. The bot token is deployment-wide and stays valid, so leaving is
 * what ends this server's grant. A missing token or an id that is not Discord's fails before the
 * span opens: neither is a call that was made.
 */
const revoke = (input: ChatInstallRevocation) => {
	const token = input.credentials.get(BOT_TOKEN_CONFIG)
	if (token === undefined) {
		return Effect.fail(revokeFailed(`Discord is not configured on this deployment (${BOT_TOKEN_CONFIG})`))
	}
	// Checked before it reaches a URL path.
	if (!isSnowflake(input.externalWorkspaceId)) {
		return Effect.fail(revokeFailed("The stored Discord server id is not a Discord id"))
	}
	return leaveGuild(Redacted.make(token), input.externalWorkspaceId)
}

const decodeSettings = (
	input: ChatWorkspaceSettings,
): Effect.Effect<ChatWorkspaceSettings, ChatSettingsRejected> =>
	// Discord defines no workspace settings: who may approve a change is not a per-server setting
	// any more, it is whether the person clicking linked their Discord account to a Maple user.
	//
	// Checked explicitly rather than through an empty schema with `onExcessProperty: "error"` — a
	// struct with no declared keys has nothing to call excess, so that decode accepts everything
	// and a key this connector does not define would land in the settings column unread.
	Rec.keys<string, string>(input).length === 0
		? Effect.succeed({})
		: Effect.fail(
				new ChatSettingsRejected({
					connector: DISCORD_CONNECTOR_ID,
					message: "Discord has no settings to configure",
				}),
			)

export const discordInstall: ChatConnectorInstall = {
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
