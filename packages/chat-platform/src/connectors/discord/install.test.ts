import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { discord } from "./index"
import { CLIENT_ID_CONFIG, CLIENT_SECRET_CONFIG, TOKEN_URL } from "./api"
import { discordAuthorizeUrl } from "./install"

const config = new Map([
	[CLIENT_ID_CONFIG, Redacted.make("client-1")],
	[CLIENT_SECRET_CONFIG, Redacted.make("secret-1")],
])

const REDIRECT_URI = "https://api.maple.test/oauth/chat/discord/callback"

/**
 * A client that dies if anything reaches it. The callback cases that use it are
 * refused before the token exchange, and this is what proves it.
 */
const noNetwork = HttpClient.make(() => Effect.die("the test made a network call"))

/** Canned token endpoint; anything else rejects. Records the form body it saw. */
const tokenFetch = (respond: () => Response, bodies: Array<string> = []) =>
	Layer.succeed(FetchHttpClient.Fetch, ((
		input: Parameters<typeof globalThis.fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input)
		if (!url.startsWith(TOKEN_URL)) return Promise.reject(new Error(`unexpected fetch: ${url}`))
		// Read the body through `Request` rather than off `init`: the client is
		// free to hand fetch a stream there.
		return new Request(url, init).text().then((body) => {
			bodies.push(body)
			return respond()
		})
	}) as typeof globalThis.fetch)

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const completeWith = (params: URLSearchParams, fetchLayer: ReturnType<typeof tokenFetch>) =>
	discord.install
		.complete({ config, params, redirectUri: REDIRECT_URI })
		.pipe(Effect.provide(Layer.provide(FetchHttpClient.layer, fetchLayer)))

describe("discord authorize URL", () => {
	it("asks for a bot authorization on the authorization-code grant", () => {
		const url = new URL(discordAuthorizeUrl("client-1", { state: "nonce", redirectUri: REDIRECT_URI }))
		assert.strictEqual(url.origin + url.pathname, "https://discord.com/oauth2/authorize")
		assert.strictEqual(url.searchParams.get("client_id"), "client-1")
		assert.strictEqual(url.searchParams.get("scope"), "bot")
		// Without these the redirect carries no code, and the guild would only be
		// knowable from the query parameter this connector refuses to trust.
		assert.strictEqual(url.searchParams.get("response_type"), "code")
		assert.strictEqual(url.searchParams.get("redirect_uri"), REDIRECT_URI)
		assert.strictEqual(url.searchParams.get("state"), "nonce")
	})

	it("requests exactly the seven documented bot permissions", () => {
		const url = new URL(discordAuthorizeUrl("client-1", { state: "nonce", redirectUri: REDIRECT_URI }))
		const requested = BigInt(url.searchParams.get("permissions") ?? "0")
		const expected =
			(1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 6n) | (1n << 35n) | (1n << 38n)
		assert.strictEqual(requested, expected)
	})

	it.effect("reports an unconfigured deployment instead of minting a broken URL", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.authorizeUrl({ config: new Map(), state: "nonce", redirectUri: REDIRECT_URI })
				.pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatConnectorNotConfigured")
		}),
	)
})

describe("discord callback", () => {
	it.effect("takes the guild from the token response, never from the callback parameter", () =>
		Effect.gen(function* () {
			const bodies: Array<string> = []
			const installed = yield* completeWith(
				// The callback names a different guild than the authorization covers:
				// this is the parameter an attacker controls, and it must not decide
				// which workspace gets linked.
				new URLSearchParams({ code: "auth-code", guild_id: "999999999999999999" }),
				tokenFetch(
					() =>
						jsonResponse({
							access_token: "discarded",
							refresh_token: "discarded",
							guild: { id: "123456789012345678", name: "Acme Engineering" },
						}),
					bodies,
				),
			)
			assert.strictEqual(installed.externalWorkspaceId, "123456789012345678")
			assert.strictEqual(installed.name, "Acme Engineering")
			// The exchange sends the code and the same redirect URI, form-encoded.
			const body = new URLSearchParams(bodies[0] ?? "")
			assert.strictEqual(body.get("grant_type"), "authorization_code")
			assert.strictEqual(body.get("code"), "auth-code")
			assert.strictEqual(body.get("redirect_uri"), REDIRECT_URI)
		}),
	)

	it.effect("falls back to the guild id when the platform reports no name", () =>
		Effect.gen(function* () {
			const installed = yield* completeWith(
				new URLSearchParams({ code: "auth-code" }),
				tokenFetch(() => jsonResponse({ guild: { id: "123456789012345678" } })),
			)
			assert.strictEqual(installed.name, "123456789012345678")
		}),
	)

	it.effect("refuses an authorization that added no bot to a server", () =>
		Effect.gen(function* () {
			const failure = yield* completeWith(
				new URLSearchParams({ code: "auth-code" }),
				tokenFetch(() => jsonResponse({ access_token: "user-only", scope: "identify" })),
			).pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatInstallFailed")
		}),
	)

	it.effect("refuses a rejected exchange and a non-JSON answer", () =>
		Effect.gen(function* () {
			const rejected = yield* completeWith(
				new URLSearchParams({ code: "auth-code" }),
				tokenFetch(() => jsonResponse({ error: "invalid_grant" }, 400)),
			).pipe(Effect.flip)
			assert.strictEqual(rejected._tag, "@maple/chat-platform/ChatInstallFailed")

			const garbled = yield* completeWith(
				new URLSearchParams({ code: "auth-code" }),
				tokenFetch(() => new Response("<html>gateway</html>", { status: 200 })),
			).pipe(Effect.flip)
			assert.strictEqual(garbled._tag, "@maple/chat-platform/ChatInstallFailed")
		}),
	)

	it.effect("refuses a callback with no code before touching the network", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.complete({
					config,
					params: new URLSearchParams({ guild_id: "123456789012345678" }),
					redirectUri: REDIRECT_URI,
				})
				.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork), Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatInstallFailed")
		}),
	)

	it.effect("surfaces a denied authorization as an install failure", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.complete({
					config,
					params: new URLSearchParams({ error: "access_denied" }),
					redirectUri: REDIRECT_URI,
				})
				.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork), Effect.flip)
			assert.include(failure.message, "access_denied")
		}),
	)

	it.effect("reports an unconfigured deployment rather than exchanging the code", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.complete({
					config: new Map([[CLIENT_ID_CONFIG, Redacted.make("client-1")]]),
					params: new URLSearchParams({ code: "auth-code" }),
					redirectUri: REDIRECT_URI,
				})
				.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork), Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatConnectorNotConfigured")
		}),
	)
})

describe("discord settings", () => {
	it.effect("accepts a role id and drops an empty one", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* discord.install.decodeSettings({ approver_role_id: "123456789012345678" }),
				{ approver_role_id: "123456789012345678" },
			)
			assert.deepStrictEqual(yield* discord.install.decodeSettings({}), {})
		}),
	)

	it.effect("rejects anything that is not a role id", () =>
		Effect.gen(function* () {
			for (const value of ["@moderators", "1234567890123456", "123456789012345678901"]) {
				const failure = yield* discord.install
					.decodeSettings({ approver_role_id: value })
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/chat-platform/ChatSettingsRejected")
			}
		}),
	)

	it.effect("rejects a key the connector does not define", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.decodeSettings({ webhook_url: "https://example.test" })
				.pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatSettingsRejected")
		}),
	)
})
