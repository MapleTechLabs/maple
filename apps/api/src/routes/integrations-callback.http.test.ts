import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { ChatCallbackRouter } from "./chat-integration.http"
import { IntegrationsCallbackRouter } from "./integrations-callback.http"

const testConfig = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_APP_BASE_URL: "https://app.example.com/",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	}),
)

// Only `Env`: a callback that tried to complete a connect would need the OAuth services and fail
// to build here, which is the point. Completion belongs to the signed-in dashboard.
const get = async (path: string) => {
	const routes = Layer.mergeAll(IntegrationsCallbackRouter, ChatCallbackRouter).pipe(
		Layer.provide(Env.layer.pipe(Layer.provide(testConfig))),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	try {
		return await handler(new Request(`https://api.example.com${path}`), Context.empty() as never)
	} finally {
		await dispose()
	}
}

describe("public OAuth callbacks", () => {
	it.each([
		["hazel", "code=c1&state=s1"],
		["cloudflare", "code=c1&state=s1"],
		["planetscale", "code=c1&state=s1"],
		["supabase", "code=c1&state=s1&iss=https%3A%2F%2Fapi.supabase.com"],
		["github", "installation_id=42&setup_action=install&code=c1&state=s1"],
	])("forwards the %s callback to the dashboard instead of completing it", async (provider, query) => {
		const response = await get(`/api/integrations/${provider}/callback?${query}`)
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe(
			`https://app.example.com/integrations?integration=${provider}&callback=oauth#${query}`,
		)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(response.headers.get("referrer-policy")).toBe("no-referrer")
	})

	it.each([
		["/oauth/chat/slack/callback", "chat-install"],
		["/oauth/chat/slack/identity/callback", "chat-identity"],
	])("forwards %s to the dashboard as %s", async (path, kind) => {
		const response = await get(`${path}?code=c1&state=s1`)
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe(
			`https://app.example.com/integrations?integration=chat-slack&callback=${kind}#code=c1&state=s1`,
		)
	})

	it("sends an unknown chat connector back with the error code, forwarding nothing", async () => {
		const response = await get("/oauth/chat/Not-A-Connector/callback?code=c1&state=s1")
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe(
			"https://app.example.com/integrations?chat=error&chat_reason=unknown",
		)
	})
})
