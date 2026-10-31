import { afterEach, describe, expect, it } from "@effect/vitest"
import { decodeOAuthReturnHash, OrgId, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { ChatCallbackRouter } from "./chat-integration.http"
import {
	CLOUDFLARE_CALLBACK_PATH,
	GITHUB_CALLBACK_PATH,
	IntegrationsCallbackRouter,
} from "./integrations-callback.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client-id",
		}),
	)

const makeHarness = () => {
	const db = createTestDb(createdDbs)
	const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
	const service = CloudflareOAuthService.layer.pipe(Layer.provideMerge(base))
	const routes = Layer.mergeAll(IntegrationsCallbackRouter, ChatCallbackRouter).pipe(
		Layer.provideMerge(base),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	return { db, handler, dispose, runtime: ManagedRuntime.make(service) }
}

const get = (path: string) => new Request(`https://api.example.com${path}`, { redirect: "manual" })

describe("provider callbacks", () => {
	it("redeem nothing themselves and hand the return to the signed-in dashboard", async () => {
		const { db, handler, dispose, runtime } = makeHarness()
		const { state } = await runtime.runPromise(
			Effect.flatMap(CloudflareOAuthService, (cf) =>
				cf.startConnect(Schema.decodeSync(OrgId)("org_a"), Schema.decodeSync(UserId)("user_a"), {
					callbackUrl: `https://api.example.com${CLOUDFLARE_CALLBACK_PATH}`,
				}),
			),
		)

		// Any browser can land here with a valid state: the request carries no Maple session.
		const response = await handler(get(`${CLOUDFLARE_CALLBACK_PATH}?code=victim-code&state=${state}`))
		expect(response.status).toBe(302)
		// Straight to the page that finishes it, not one the dashboard redirects away from.
		const location = new URL(response.headers.get("location") ?? "")
		expect(location.origin + location.pathname).toBe("https://app.example.com/sources/new")
		// The location carries the provider's code: never cached, never sent on as a Referer.
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(response.headers.get("referrer-policy")).toBe("no-referrer")
		expect(location.searchParams.get("integration")).toBe("cloudflare")
		const handed = Option.getOrThrow(decodeOAuthReturnHash(location.hash))
		expect(handed.flow).toBe("cloudflare")
		expect(new URLSearchParams(handed.query).get("code")).toBe("victim-code")

		// The state is still unredeemed and nothing connected: only `oauthComplete` can finish it.
		const row = await queryFirstRow<{ org_id: string }>(
			db,
			"SELECT org_id FROM oauth_auth_states WHERE state = $1",
			[state],
		)
		expect(row?.org_id).toBe("org_a")
		const status = await runtime.runPromise(
			Effect.flatMap(CloudflareOAuthService, (cf) => cf.getStatus(Schema.decodeSync(OrgId)("org_a"))),
		)
		expect(status.connected).toBe(false)
		await runtime.dispose()
		await dispose()
	})

	it("shows the provider's refusal on the API page without touching the dashboard", async () => {
		const { handler, dispose, runtime } = makeHarness()
		const response = await handler(get(`${CLOUDFLARE_CALLBACK_PATH}?error=access_denied`))
		expect(response.status).toBe(400)
		expect(await response.text()).toContain("access_denied")
		await runtime.dispose()
		await dispose()
	})

	it.each([
		["an install awaiting org approval", "?code=c&setup_action=request", "Installation requested"],
		["a return without an installation", "?code=c&state=s", "Missing installation_id"],
		["an install started on GitHub without a state", "?code=c&installation_id=1", "Missing state"],
	])("refuses %s on the API page and hands nothing on", async (_name, query, message) => {
		const { handler, dispose, runtime } = makeHarness()
		const response = await handler(get(`${GITHUB_CALLBACK_PATH}${query}`))
		expect(response.status).toBe(400)
		expect(response.headers.get("location")).toBeNull()
		expect(await response.text()).toContain(message)
		await runtime.dispose()
		await dispose()
	})

	it("hands a chat link return to the dashboard under its connector", async () => {
		const { handler, dispose, runtime } = makeHarness()
		const response = await handler(get("/oauth/chat/slack/identity/callback?code=c&state=s"))
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get("location") ?? "")
		expect(location.searchParams.get("integration")).toBe("chat-slack")
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(response.headers.get("referrer-policy")).toBe("no-referrer")
		const handed = Option.getOrThrow(decodeOAuthReturnHash(location.hash))
		expect(handed.flow).toBe("chat_identity")
		expect(handed.connector).toBe("slack")
		await runtime.dispose()
		await dispose()
	})
})
