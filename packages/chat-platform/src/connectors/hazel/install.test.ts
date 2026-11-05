import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Record as Rec } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import type { ChatConnectorConfig } from "../../install"
import { BOT_ID_CONFIG, BOT_TOKEN_CONFIG, REGION_CONFIG } from "./api"
import { isConnectorConfigured } from "../../index"
import { hazel } from "./index"
import { hazelInstall, hazelInstallUrl, hazelRedirectUri } from "./install"

const config: ChatConnectorConfig = new Map([
	[BOT_ID_CONFIG, Redacted.make("bot-1")],
	[BOT_TOKEN_CONFIG, Redacted.make("hzl_bot_token")],
])
const redirectUri = "https://api.maple.dev/oauth/chat/hazel/callback"

/** Answers the redemption with `status`/`body`, and the settings PATCH with `settingsStatus`. */
const stub = (status: number, body: string, settingsStatus = 200) => {
	const seen: Array<HttpClientRequest.HttpClientRequest> = []
	const client = HttpClient.make((request) => {
		seen.push(request)
		const response =
			request.method === "PATCH"
				? new Response(JSON.stringify({ success: true }), { status: settingsStatus })
				: new Response(body, { status })
		return Effect.succeed(HttpClientResponse.fromWeb(request, response))
	})
	return { seen, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

/** A request's JSON body, compared whole against what the test expects. */
type SentBody = Readonly<Record<string, unknown>>

const sentBody = (request: HttpClientRequest.HttpClientRequest): SentBody => {
	const body = request.body
	if (body._tag !== "Uint8Array") throw new Error("the request carried no JSON body")
	// SAFETY: the body under test is one this transport just wrote; a wrong shape fails the assertion.
	return JSON.parse(new TextDecoder().decode(body.body)) as SentBody
}

describe("hazel install", () => {
	it("sends the admin to Hazel's consent page for this bot", () => {
		const url = new URL(hazelInstallUrl("bot-1", { state: "nonce", redirectUri }))
		expect(`${url.origin}${url.pathname}`).toBe("https://app.hazel.sh/oauth/bot-install")
		expect(Rec.fromEntries(url.searchParams)).toEqual({
			bot_id: "bot-1",
			redirect_uri: redirectUri,
			state: "nonce",
		})
	})

	it("is configured without a region, and not without its token", () => {
		expect(isConnectorConfigured(hazel, config)).toBe(true)
		expect(isConnectorConfigured(hazel, new Map([...config, [REGION_CONFIG, Redacted.make("eu")]]))).toBe(
			true,
		)
		expect(isConnectorConfigured(hazel, new Map([[BOT_ID_CONFIG, Redacted.make("bot-1")]]))).toBe(false)
	})

	it.effect("names this instance's region in its callback, on the link and the redemption", () => {
		const http = stub(
			200,
			JSON.stringify({ organizationId: "org-1", organizationName: "Acme", installedBy: "u" }),
		)
		const regional = new Map([...config, [REGION_CONFIG, Redacted.make("eu")]])
		const regionalUri = `${redirectUri}?hazel_region=eu`
		return Effect.gen(function* () {
			const link = new URL(
				yield* hazelInstall.authorizeUrl({ config: regional, state: "nonce", redirectUri }),
			)
			expect(link.searchParams.get("redirect_uri")).toBe(regionalUri)
			expect(link.searchParams.has("region")).toBe(false)
			yield* hazelInstall.complete({
				config: regional,
				params: new URLSearchParams({ code: "org-1.secret", state: "nonce", hazel_region: "eu" }),
				redirectUri,
			})
			expect(sentBody(http.seen[0])).toEqual({ code: "org-1.secret", redirectUri: regionalUri })
		}).pipe(Effect.provide(http.layer))
	})

	it("leaves the callback alone without a region", () => {
		expect(hazelRedirectUri(redirectUri, config)).toBe(redirectUri)
	})

	it.effect("redeems the code with the bot's own token for the workspace it names", () => {
		const http = stub(
			200,
			JSON.stringify({ organizationId: "org-1", organizationName: "Acme", installedBy: "u" }),
		)
		return Effect.gen(function* () {
			const result = yield* hazelInstall.complete({
				config,
				params: new URLSearchParams({
					code: "org-1.secret",
					state: "nonce",
					organizationId: "org-evil",
				}),
				redirectUri,
			})
			expect(result).toEqual({ externalWorkspaceId: "org-1", name: "Acme" })
			const [request] = http.seen
			expect(request?.url).toBe("https://api.hazel.sh/api/v1/bot-installs/token")
			expect(request?.headers["authorization"]).toBe("Bearer hzl_bot_token")
			expect(sentBody(request)).toEqual({ code: "org-1.secret", redirectUri })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("makes the bot mentionable with its own token once the install is redeemed", () => {
		const http = stub(200, JSON.stringify({ organizationId: "org-1", organizationName: "Acme" }))
		return Effect.gen(function* () {
			yield* hazelInstall.complete({ config, params: new URLSearchParams({ code: "c" }), redirectUri })
			const [, settings] = http.seen
			expect(settings?.method).toBe("PATCH")
			expect(settings?.url).toBe("https://api.hazel.sh/bot-commands/settings")
			expect(settings?.headers["authorization"]).toBe("Bearer hzl_bot_token")
			expect(sentBody(settings)).toEqual({ mentionable: true })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("fails the install when Hazel refuses to make the bot mentionable", () => {
		const http = stub(200, JSON.stringify({ organizationId: "org-1", organizationName: "Acme" }), 500)
		return Effect.gen(function* () {
			const failed = yield* Effect.flip(
				hazelInstall.complete({ config, params: new URLSearchParams({ code: "c" }), redirectUri }),
			)
			expect(failed.message).toContain("mentionable failed with HTTP 500")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("fails a declined install, a missing code and a refused one without calling out twice", () => {
		const http = stub(400, JSON.stringify({ _tag: "BotInstallGrantInvalidError", message: "x" }))
		return Effect.gen(function* () {
			const declined = yield* Effect.flip(
				hazelInstall.complete({
					config,
					params: new URLSearchParams({ error: "access_denied" }),
					redirectUri,
				}),
			)
			expect(declined.message).toContain("access_denied")
			const missing = yield* Effect.flip(
				hazelInstall.complete({ config, params: new URLSearchParams(), redirectUri }),
			)
			expect(missing._tag).toBe("@maple/chat-platform/ChatInstallFailed")
			const refused = yield* Effect.flip(
				hazelInstall.complete({ config, params: new URLSearchParams({ code: "c" }), redirectUri }),
			)
			expect(refused.message).toContain("expired or was already used")
			expect(http.seen).toHaveLength(1)
		}).pipe(Effect.provide(http.layer))
	})
})
