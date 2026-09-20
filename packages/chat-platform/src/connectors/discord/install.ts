import { ChatConnectorId } from "@maple/primitives"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	ChatInstallFailed,
	ChatSettingsRejected,
	requireConfig,
	type ChatConnectorInstall,
	type ChatInstallCallback,
	type ChatInstallStart,
	type ChatWorkspaceSettings,
} from "../../install"

export const DISCORD_CONNECTOR_ID = Schema.decodeSync(ChatConnectorId)("discord")

/** Config the host supplies; see this directory's README for the app setup. */
export const DISCORD_CLIENT_ID = "DISCORD_CLIENT_ID"
export const DISCORD_CLIENT_SECRET = "DISCORD_CLIENT_SECRET"

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
const TOKEN_URL = "https://discord.com/api/v10/oauth2/token"

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
 * Discord snowflake: an unsigned 64-bit id as a decimal string. Guild and role
 * ids both use it, and keeping the check here means a hand-typed role id is a
 * 400 rather than a value the gateway silently never matches.
 */
const Snowflake = Schema.String.check(Schema.isPattern(/^\d{17,20}$/))

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
 * The one setting Discord carries in V1 — see this directory's README. Decoded
 * with `onExcessProperty: "error"` so a key this connector does not define is
 * reported rather than silently dropped on the way into the settings column.
 */
const DiscordSettings = Schema.Struct({ approver_role_id: Schema.optionalKey(Snowflake) })
const decodeDiscordSettings = Schema.decodeUnknownEffect(DiscordSettings, {
	onExcessProperty: "error",
})

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
	Effect.map(requireConfig(input.config, DISCORD_CONNECTOR_ID, DISCORD_CLIENT_ID), (clientId) =>
		discordAuthorizeUrl(clientId, { state: input.state, redirectUri: input.redirectUri }),
	)

const installFailed = (message: string, cause?: unknown) =>
	new ChatInstallFailed({
		connector: DISCORD_CONNECTOR_ID,
		message,
		...(cause === undefined ? undefined : { cause }),
	})

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
	const denied = input.params.get("error")
	if (denied !== null) {
		return yield* Effect.fail(installFailed(`Discord rejected the authorization: ${denied}`))
	}
	const code = input.params.get("code")
	if (code === null) {
		return yield* Effect.fail(installFailed("Discord's callback carried no authorization code"))
	}
	const clientId = yield* requireConfig(input.config, DISCORD_CONNECTOR_ID, DISCORD_CLIENT_ID)
	const clientSecret = yield* requireConfig(input.config, DISCORD_CONNECTOR_ID, DISCORD_CLIENT_SECRET)

	const httpClient = yield* HttpClient.HttpClient
	const request = HttpClientRequest.post(TOKEN_URL, { headers: { accept: "application/json" } }).pipe(
		// Discord's token endpoint accepts client credentials in the form body or
		// as HTTP Basic, and only `application/x-www-form-urlencoded` bodies.
		HttpClientRequest.bodyUrlParams({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "authorization_code",
			code,
			redirect_uri: input.redirectUri,
		}),
	)
	const response = yield* httpClient
		.execute(request)
		.pipe(
			Effect.mapError((error) =>
				installFailed(`Discord token exchange failed: ${error.message}`, error),
			),
		)
	if (response.status < 200 || response.status >= 300) {
		return yield* Effect.fail(installFailed(`Discord token exchange failed with HTTP ${response.status}`))
	}
	const json = yield* response.json.pipe(
		Effect.mapError((error) => installFailed("Discord returned a non-JSON token response", error)),
	)
	const decoded = yield* decodeTokenResponse(json).pipe(
		Effect.mapError((error) => installFailed("Discord returned an unexpected token response", error)),
	)
	const guild = decoded.guild
	if (guild === undefined) {
		// No guild means the authorization was not a bot install (or the app's
		// install settings overrode the requested scope) — there is nothing to link.
		return yield* Effect.fail(installFailed("Discord's authorization did not add the bot to a server"))
	}
	return { externalWorkspaceId: guild.id, name: guild.name ?? guild.id }
})

const decodeSettings = (
	input: ChatWorkspaceSettings,
): Effect.Effect<ChatWorkspaceSettings, ChatSettingsRejected> =>
	decodeDiscordSettings(input).pipe(
		Effect.mapError(
			() =>
				new ChatSettingsRejected({
					connector: DISCORD_CONNECTOR_ID,
					message:
						"Discord takes one setting, approver_role_id, and it must be a Discord role ID (17–20 digits)",
				}),
		),
		Effect.map(
			(settings): ChatWorkspaceSettings =>
				settings.approver_role_id === undefined
					? {}
					: { approver_role_id: settings.approver_role_id },
		),
	)

export const discordInstall: ChatConnectorInstall = {
	requiredConfig: [DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET],
	authorizeUrl,
	complete,
	decodeSettings,
}
