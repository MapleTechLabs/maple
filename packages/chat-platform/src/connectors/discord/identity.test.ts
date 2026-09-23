/**
 * Discord's identity half, against a canned Discord.
 *
 * The property worth pinning is that the account id comes from `/users/@me` asked WITH the grant,
 * never from a callback parameter — the parameters belong to whoever opened the URL, and this id
 * is what a later button click is matched against.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { discord } from "./index"
import { API_BASE, CLIENT_ID_CONFIG, CLIENT_SECRET_CONFIG, TOKEN_URL } from "./api"
import { discordIdentityAuthorizeUrl } from "./identity"

const config = new Map([
	[CLIENT_ID_CONFIG, Redacted.make("client-1")],
	[CLIENT_SECRET_CONFIG, Redacted.make("secret-1")],
])

const REDIRECT_URI = "https://api.maple.test/oauth/chat/discord/identity/callback"
const USER_URL = `${API_BASE}/users/@me`

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Canned token endpoint then user endpoint; anything else rejects. Records what each was sent. */
const discordFetch = (
	user: unknown,
	options: { readonly userStatus?: number; readonly seen?: Array<string> } = {},
) =>
	Layer.succeed(FetchHttpClient.Fetch, ((
		input: Parameters<typeof globalThis.fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input)
		if (url.startsWith(TOKEN_URL)) {
			return Promise.resolve(jsonResponse({ access_token: "at-1", token_type: "Bearer" }))
		}
		if (url.startsWith(USER_URL)) {
			options.seen?.push(new Request(url, init).headers.get("authorization") ?? "")
			return Promise.resolve(jsonResponse(user, options.userStatus ?? 200))
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`))
	}) as typeof globalThis.fetch)

const identity = discord.identity
assert(identity !== undefined, "discord declares an identity half")

const completeWith = (params: URLSearchParams, fetchLayer: ReturnType<typeof discordFetch>) =>
	identity
		.complete({ config, params, redirectUri: REDIRECT_URI })
		.pipe(Effect.provide(Layer.provide(FetchHttpClient.layer, fetchLayer)))

describe("discord identity authorize URL", () => {
	it("asks for `identify` and nothing else", () => {
		const url = new URL(
			discordIdentityAuthorizeUrl("client-1", { state: "s1", redirectUri: REDIRECT_URI }),
		)
		assert.strictEqual(url.origin + url.pathname, "https://discord.com/oauth2/authorize")
		assert.strictEqual(url.searchParams.get("scope"), "identify")
		assert.strictEqual(url.searchParams.get("response_type"), "code")
		assert.strictEqual(url.searchParams.get("state"), "s1")
		assert.strictEqual(url.searchParams.get("redirect_uri"), REDIRECT_URI)
		// No `bot`, no `permissions`: linking an account adds nothing to a server.
		assert.isNull(url.searchParams.get("permissions"))
	})
})

describe("discord identity callback", () => {
	it.effect("reads the account from the grant, not from the callback's parameters", () =>
		Effect.gen(function* () {
			const seen: Array<string> = []
			const result = yield* completeWith(
				// A forged id on the callback must not be what gets stored.
				new URLSearchParams({ code: "c1", user_id: "9999999999999999999" }),
				discordFetch({ id: "1122334455667788990", global_name: "Ada", username: "ada_l" }, { seen }),
			)

			assert.deepStrictEqual(result, { externalUserId: "1122334455667788990", displayName: "Ada" })
			// The lookup is authenticated with the token the exchange returned.
			assert.deepStrictEqual(seen, ["Bearer at-1"])
		}),
	)

	it.effect("falls back to the username when the account set no display name", () =>
		Effect.gen(function* () {
			const result = yield* completeWith(
				new URLSearchParams({ code: "c1" }),
				discordFetch({ id: "1122334455667788990", global_name: null, username: "ada_l" }),
			)

			assert.deepStrictEqual(result, { externalUserId: "1122334455667788990", displayName: "ada_l" })
		}),
	)

	it.effect("fails rather than linking when Discord will not say who it is", () =>
		Effect.gen(function* () {
			const failure = yield* completeWith(
				new URLSearchParams({ code: "c1" }),
				discordFetch({ message: "401: Unauthorized" }, { userStatus: 401 }),
			).pipe(Effect.flip)

			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatIdentityFailed")
		}),
	)

	it.effect("refuses a callback that carries no code", () =>
		Effect.gen(function* () {
			const failure = yield* completeWith(
				new URLSearchParams({ error: "access_denied" }),
				discordFetch({}),
			).pipe(Effect.flip)

			assert.strictEqual(failure._tag, "@maple/chat-platform/ChatIdentityFailed")
		}),
	)
})
