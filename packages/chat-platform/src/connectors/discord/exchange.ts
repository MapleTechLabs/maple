/**
 * The authorization-code exchange both halves of this connector run.
 *
 * Install and identity are the same OAuth application, the same endpoint and the same grant; they
 * differ only in the scope they asked for and what they read out of the answer. This does the
 * common part and hands back the decoded JSON, so each half decodes its own shape and fails with
 * its own error.
 *
 * `fail` is passed in rather than a shared error type because a failed install and a failed link
 * are different things to the route above: one is a workspace that did not link, the other is a
 * person whose account did not.
 */
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { requireConfig, type ChatConnectorNotConfigured, type ChatInstallCallback } from "../../install"
import { CLIENT_ID_CONFIG, CLIENT_SECRET_CONFIG, TOKEN_URL } from "./api"
import { DISCORD_CONNECTOR_ID } from "./id"

/**
 * Trade the callback's code for Discord's token response, as raw JSON.
 *
 * Every step that can fail says which one it was: a rejected authorization, a callback with no
 * code, an unreachable endpoint, a non-2xx, and a body that is not JSON all read differently in a
 * log, and collapsing them files a Discord outage as Maple's bug.
 */
export const exchangeCode = <E>(
	input: ChatInstallCallback,
	fail: (message: string) => E,
): Effect.Effect<unknown, E | ChatConnectorNotConfigured, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const denied = input.params.get("error")
		if (denied !== null) {
			return yield* Effect.fail(fail(`Discord rejected the authorization: ${denied}`))
		}
		const code = input.params.get("code")
		if (code === null) {
			return yield* Effect.fail(fail("Discord's callback carried no authorization code"))
		}
		const clientId = yield* requireConfig(input.config, DISCORD_CONNECTOR_ID, CLIENT_ID_CONFIG)
		const clientSecret = yield* requireConfig(input.config, DISCORD_CONNECTOR_ID, CLIENT_SECRET_CONFIG)

		const httpClient = yield* HttpClient.HttpClient
		const response = yield* httpClient
			.execute(
				HttpClientRequest.post(TOKEN_URL, { headers: { accept: "application/json" } }).pipe(
					// Discord's token endpoint accepts client credentials in the form body or as HTTP
					// Basic, and only `application/x-www-form-urlencoded` bodies.
					HttpClientRequest.bodyUrlParams({
						client_id: clientId,
						client_secret: clientSecret,
						grant_type: "authorization_code",
						code,
						redirect_uri: input.redirectUri,
					}),
				),
			)
			.pipe(Effect.mapError((error) => fail(`Discord token exchange failed: ${error.message}`)))
		if (response.status < 200 || response.status >= 300) {
			return yield* Effect.fail(fail(`Discord token exchange failed with HTTP ${response.status}`))
		}
		return yield* response.json.pipe(
			Effect.mapError(() => fail("Discord returned a non-JSON token response")),
		)
	})
