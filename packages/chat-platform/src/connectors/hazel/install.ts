import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	ChatInstallFailed,
	ChatSettingsRejected,
	requireConfig,
	type ChatConnectorInstall,
	type ChatInstallCallback,
	type ChatInstallStart,
	type ChatWorkspaceSettings,
} from "../../install"
import { API_BASE, API_HOST, BOT_ID_CONFIG, BOT_SETTINGS_URL, BOT_TOKEN_CONFIG, INSTALL_URL } from "./api"
import { HAZEL_CONNECTOR_ID } from "./id"

/**
 * What Hazel answers a redeemed install grant with: the workspace the admin installed the bot in.
 * Only the id and the name are read.
 */
const RedeemedInstall = Schema.Struct({
	organizationId: Schema.String.check(Schema.isMinLength(1)),
	organizationName: Schema.String,
})
const decodeRedeemedInstall = Schema.decodeUnknownEffect(RedeemedInstall)

/**
 * The install link. Hazel's consent page checks `redirect_uri` against the URIs the bot's owner
 * registered on the bot (exactly), so the callback has to be one of them; `state` is the host's
 * single-use nonce and comes back untouched.
 */
export const hazelInstallUrl = (botId: string, input: { state: string; redirectUri: string }): string => {
	const params = new URLSearchParams({ bot_id: botId, redirect_uri: input.redirectUri, state: input.state })
	return `${INSTALL_URL}?${params.toString()}`
}

const authorizeUrl = (input: ChatInstallStart) =>
	Effect.map(requireConfig(input.config, HAZEL_CONNECTOR_ID, BOT_ID_CONFIG), (botId) =>
		hazelInstallUrl(botId, { state: input.state, redirectUri: input.redirectUri }),
	)

/** The redemption POST, as one client span on the service map. */
const redeem = Effect.fn("Hazel.request", { kind: "client" })(function* (
	token: string,
	code: string,
	redirectUri: string,
) {
	yield* Effect.annotateCurrentSpan({
		"peer.service": "hazel",
		"http.request.method": "POST",
		"server.address": API_HOST,
		"url.template": "/bot-installs/token",
	})
	const client = yield* HttpClient.HttpClient
	const response = yield* client
		.execute(
			HttpClientRequest.post(`${API_BASE}/bot-installs/token`, {
				headers: { accept: "application/json", authorization: `Bearer ${token}` },
			}).pipe(HttpClientRequest.bodyJsonUnsafe({ code, redirectUri })),
		)
		// The message only: the request carries the bot token.
		.pipe(
			Effect.mapError((error) =>
				installFailed(`Hazel install redemption failed: ${error.reason._tag}`),
			),
		)
	yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
	return response
})

/**
 * Let people @mention the bot. Hazel creates every bot unmentionable and only the bot's own token
 * can change that, so without this call the bot never shows in the composer's mention list and no
 * one can start a conversation with it. Idempotent: every install sets it again.
 */
const markMentionable = Effect.fn("Hazel.request", { kind: "client" })(function* (token: string) {
	yield* Effect.annotateCurrentSpan({
		"peer.service": "hazel",
		"http.request.method": "PATCH",
		"server.address": API_HOST,
		"url.template": "/bot-commands/settings",
	})
	const client = yield* HttpClient.HttpClient
	const response = yield* client
		.execute(
			HttpClientRequest.patch(BOT_SETTINGS_URL, {
				headers: { accept: "application/json", authorization: `Bearer ${token}` },
			}).pipe(HttpClientRequest.bodyJsonUnsafe({ mentionable: true })),
		)
		.pipe(
			Effect.mapError((error) =>
				installFailed(`Making the Hazel bot mentionable failed: ${error.reason._tag}`),
			),
		)
	yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
	if (response.status < 200 || response.status >= 300) {
		return yield* Effect.fail(
			installFailed(`Making the Hazel bot mentionable failed with HTTP ${response.status}`),
		)
	}
})

const installFailed = (message: string) => new ChatInstallFailed({ connector: HAZEL_CONNECTOR_ID, message })

/**
 * Redeem the callback's code for the workspace it was issued against.
 *
 * The workspace comes from Hazel's answer, never from the callback: the code is bound to this bot,
 * this redirect URI and the workspace the admin approved, is single-use and lives ten minutes, and
 * only the bot's own token can redeem it. Hazel lets only a workspace's owners and admins approve,
 * so a redeemed code is proof that an admin of that workspace installed the bot there.
 */
const complete = Effect.fnUntraced(function* (input: ChatInstallCallback) {
	const denied = input.params.get("error")
	if (denied !== null) return yield* Effect.fail(installFailed(`Hazel declined the install: ${denied}`))
	const code = input.params.get("code")
	if (code === null) return yield* Effect.fail(installFailed("Hazel's callback carried no install code"))
	const token = yield* requireConfig(input.config, HAZEL_CONNECTOR_ID, BOT_TOKEN_CONFIG)
	const response = yield* redeem(token, code, input.redirectUri)
	if (response.status === 400) {
		return yield* Effect.fail(
			installFailed("Hazel refused the install code: it expired or was already used"),
		)
	}
	if (response.status < 200 || response.status >= 300) {
		return yield* Effect.fail(
			installFailed(`Hazel install redemption failed with HTTP ${response.status}`),
		)
	}
	const json = yield* response.json.pipe(
		Effect.mapError(() => installFailed("Hazel returned a non-JSON install response")),
	)
	const redeemed = yield* decodeRedeemedInstall(json).pipe(
		Effect.mapError(() => installFailed("Hazel returned an unexpected install response")),
	)
	yield* markMentionable(token)
	return { externalWorkspaceId: redeemed.organizationId, name: redeemed.organizationName }
})

const decodeSettings = (
	input: ChatWorkspaceSettings,
): Effect.Effect<ChatWorkspaceSettings, ChatSettingsRejected> =>
	// Checked explicitly rather than through an empty schema: a struct with no keys has nothing to
	// call excess, so that decode accepts everything.
	Object.keys(input).length === 0
		? Effect.succeed({})
		: Effect.fail(
				new ChatSettingsRejected({
					connector: HAZEL_CONNECTOR_ID,
					message: "Hazel has no settings to configure",
				}),
			)

export const hazelInstall: ChatConnectorInstall = {
	requiredConfig: [
		{ name: BOT_ID_CONFIG, secret: false },
		{ name: BOT_TOKEN_CONFIG, secret: true },
	],
	authorizeUrl,
	complete,
	decodeSettings,
}
