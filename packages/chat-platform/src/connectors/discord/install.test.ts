import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { HttpClient } from "effect/unstable/http"
import { discord } from "./index"
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, discordAuthorizeUrl } from "./install"

const config = new Map([
	[DISCORD_CLIENT_ID, Redacted.make("client-1")],
	[DISCORD_CLIENT_SECRET, Redacted.make("secret-1")],
])

const REDIRECT_URI = "https://api.maple.test/oauth/chat/discord/callback"

/**
 * A client that dies if anything reaches it. Every callback case below is
 * refused before the token exchange, and this is what proves it.
 */
const noNetwork = HttpClient.make(() => Effect.die("the test made a network call"))

describe("discord authorize URL", () => {
	it("asks for a bot authorization on the authorization-code grant", () => {
		const url = new URL(discordAuthorizeUrl("client-1", { state: "nonce", redirectUri: REDIRECT_URI }))
		expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize")
		expect(url.searchParams.get("client_id")).toBe("client-1")
		expect(url.searchParams.get("scope")).toBe("bot")
		// Without these the redirect carries no code, and the guild would only be
		// knowable from the query parameter this connector refuses to trust.
		expect(url.searchParams.get("response_type")).toBe("code")
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI)
		expect(url.searchParams.get("state")).toBe("nonce")
	})

	it("requests exactly the seven documented bot permissions", () => {
		const url = new URL(discordAuthorizeUrl("client-1", { state: "nonce", redirectUri: REDIRECT_URI }))
		const requested = BigInt(url.searchParams.get("permissions") ?? "0")
		const expected =
			(1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 6n) | (1n << 35n) | (1n << 38n)
		expect(requested).toBe(expected)
	})

	it.effect("reports an unconfigured deployment instead of minting a broken URL", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.authorizeUrl({ config: new Map(), state: "nonce", redirectUri: REDIRECT_URI })
				.pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/chat-platform/ChatConnectorNotConfigured")
		}),
	)
})

describe("discord callback", () => {
	it.effect("refuses a callback with no code before touching the network", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.complete({
					config,
					params: new URLSearchParams({ guild_id: "123456789012345678" }),
					redirectUri: REDIRECT_URI,
				})
				.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork), Effect.flip)
			expect(failure._tag).toBe("@maple/chat-platform/ChatInstallFailed")
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
			expect(failure.message).toContain("access_denied")
		}),
	)
})

describe("discord settings", () => {
	it.effect("accepts a role id and drops an empty one", () =>
		Effect.gen(function* () {
			expect(yield* discord.install.decodeSettings({ approver_role_id: "123456789012345678" })).toEqual(
				{
					approver_role_id: "123456789012345678",
				},
			)
			expect(yield* discord.install.decodeSettings({})).toEqual({})
		}),
	)

	it.effect("rejects anything that is not a role id", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.decodeSettings({ approver_role_id: "@moderators" })
				.pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/chat-platform/ChatSettingsRejected")
		}),
	)

	it.effect("rejects a key the connector does not define", () =>
		Effect.gen(function* () {
			const failure = yield* discord.install
				.decodeSettings({ webhook_url: "https://example.test" })
				.pipe(Effect.flip)
			expect(failure._tag).toBe("@maple/chat-platform/ChatSettingsRejected")
		}),
	)
})
