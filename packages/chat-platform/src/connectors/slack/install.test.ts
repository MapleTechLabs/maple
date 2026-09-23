import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { BOT_SCOPES, CLIENT_ID_CONFIG, CLIENT_SECRET_CONFIG, TOKEN_URL } from "./api"
import { decodeSlackCredentials } from "./credentials"
import { slack } from "./index"
import { slackAuthorizeUrl } from "./install"

const config = new Map([
	[CLIENT_ID_CONFIG, Redacted.make("client-1")],
	[CLIENT_SECRET_CONFIG, Redacted.make("secret-1")],
])

const REDIRECT_URI = "https://api.maple.test/oauth/chat/slack/callback"

/**
 * A client that dies if anything reaches it. The callback cases that use it are refused before the
 * token exchange, and this is what proves it.
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
		// Read the body through `Request` rather than off `init`: the client is free to hand fetch a
		// stream there.
		return new Request(url, init).text().then((body) => {
			bodies.push(body)
			return respond()
		})
	}) as typeof globalThis.fetch)

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const completeWith = (params: URLSearchParams, fetchLayer: ReturnType<typeof tokenFetch>) =>
	slack.install
		.complete({ config, params, redirectUri: REDIRECT_URI })
		.pipe(Effect.provide(Layer.provide(FetchHttpClient.layer, fetchLayer)))

/** What `oauth.v2.access` answers a single-workspace bot install with. */
const INSTALLED = {
	ok: true,
	// Prefix-shaped but deliberately not token-shaped: a fixture that matches the real pattern is
	// a fixture secret scanners block the push over.
	access_token: "xoxb-a-workspaces-own-token",
	token_type: "bot",
	scope: BOT_SCOPES.join(","),
	bot_user_id: "U0KRQLJ9H",
	app_id: "A0KRD7HC3",
	team: { id: "T9TK3CUKW", name: "Maple" },
	authed_user: { id: "U1234" },
	enterprise: null,
	is_enterprise_install: false,
}

describe("slack authorize URL", () => {
	it("asks for the bot scopes and nothing a user token would need", () => {
		const url = new URL(slackAuthorizeUrl("client-1", { state: "nonce", redirectUri: REDIRECT_URI }))
		assert.strictEqual(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize")
		assert.strictEqual(url.searchParams.get("client_id"), "client-1")
		assert.strictEqual(url.searchParams.get("scope"), BOT_SCOPES.join(","))
		assert.strictEqual(url.searchParams.get("redirect_uri"), REDIRECT_URI)
		assert.strictEqual(url.searchParams.get("state"), "nonce")
		// No user token is asked for, so Maple never holds an installer's identity.
		assert.isNull(url.searchParams.get("user_scope"))
	})

	it("asks for the six scopes the connector actually uses", () => {
		assert.deepStrictEqual(
			[...BOT_SCOPES],
			[
				"app_mentions:read",
				"chat:write",
				"channels:history",
				"groups:history",
				"im:history",
				"mpim:history",
			],
		)
	})

	it.effect("reports an unconfigured deployment instead of minting a broken URL", () =>
		Effect.gen(function* () {
			const failure = yield* slack.install
				.authorizeUrl({ config: new Map(), state: "nonce", redirectUri: REDIRECT_URI })
				.pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatConnectorNotConfigured")
		}),
	)
})

describe("slack install callback", () => {
	it.effect("exchanges the code for the workspace and its own bot token", () =>
		Effect.gen(function* () {
			const bodies: Array<string> = []
			const installed = yield* completeWith(
				new URLSearchParams({ code: "abc", state: "nonce" }),
				tokenFetch(() => jsonResponse(INSTALLED), bodies),
			)
			assert.strictEqual(installed.externalWorkspaceId, "T9TK3CUKW")
			assert.strictEqual(installed.name, "Maple")

			const sent = new URLSearchParams(bodies[0] ?? "")
			assert.strictEqual(sent.get("code"), "abc")
			assert.strictEqual(sent.get("client_id"), "client-1")
			assert.strictEqual(sent.get("client_secret"), "secret-1")
			assert.strictEqual(sent.get("redirect_uri"), REDIRECT_URI)
		}),
	)

	it.effect("hands the host a credential only this connector can read back", () =>
		Effect.gen(function* () {
			const installed = yield* completeWith(
				new URLSearchParams({ code: "abc" }),
				tokenFetch(() => jsonResponse(INSTALLED)),
			)
			const credentials = decodeSlackCredentials(installed.credentials)
			assert.deepStrictEqual(
				Option.match(credentials, { onNone: () => null, onSome: (value) => value }),
				{ bot_token: INSTALLED.access_token, bot_user_id: "U0KRQLJ9H" },
			)
		}),
	)

	it.effect("refuses an enterprise-wide install by name rather than as a missing team", () =>
		Effect.gen(function* () {
			// Slack answers this with `team: null` and a token that spans every workspace in the org —
			// so the row this would write could not be resolved from any event's `team_id`.
			const failure = yield* completeWith(
				new URLSearchParams({ code: "abc" }),
				tokenFetch(() =>
					jsonResponse({
						...INSTALLED,
						team: null,
						is_enterprise_install: true,
						enterprise: { id: "E123ABC456", name: "Maple Inc" },
					}),
				),
			).pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatInstallFailed")
			assert.include(failure.message, "enterprise-wide")
		}),
	)

	it.effect("treats Slack's 200-with-ok-false as the refusal it is", () =>
		Effect.gen(function* () {
			const failure = yield* completeWith(
				new URLSearchParams({ code: "abc" }),
				tokenFetch(() => jsonResponse({ ok: false, error: "invalid_code" })),
			).pipe(Effect.flip)
			assert.include(failure.message, "invalid_code")
		}),
	)

	it.effect("refuses a callback Slack rejected, without calling the token endpoint", () =>
		Effect.gen(function* () {
			const failure = yield* slack.install
				.complete({
					config,
					params: new URLSearchParams({ error: "access_denied" }),
					redirectUri: REDIRECT_URI,
				})
				.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork), Effect.flip)
			assert.include(failure.message, "access_denied")
		}),
	)

	it.effect("refuses a callback with no code at all", () =>
		Effect.gen(function* () {
			const failure = yield* slack.install
				.complete({ config, params: new URLSearchParams(), redirectUri: REDIRECT_URI })
				.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork), Effect.flip)
			assert.include(failure.message, "no authorization code")
		}),
	)

	it.effect("refuses a token response that names no bot user", () =>
		Effect.gen(function* () {
			const { bot_user_id: _dropped, ...withoutBot } = INSTALLED
			const failure = yield* completeWith(
				new URLSearchParams({ code: "abc" }),
				tokenFetch(() => jsonResponse(withoutBot)),
			).pipe(Effect.flip)
			assert.include(failure.message, "named no workspace and bot user")
		}),
	)
})

describe("slack settings", () => {
	it.effect("accepts nothing, and says so rather than dropping a key", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* slack.install.decodeSettings({}), {})
			const failure = yield* slack.install.decodeSettings({ approver_role_id: "R1" }).pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatSettingsRejected")
		}),
	)
})
