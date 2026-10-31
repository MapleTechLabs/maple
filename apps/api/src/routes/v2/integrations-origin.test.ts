import type { HttpServerRequest } from "effect/http"
import { assert, describe, it } from "@effect/vitest"
import { isTrustedCallbackOrigin, resolveRequestOrigin } from "./integrations.http"

/**
 * `resolveRequestOrigin` is a pure header/url function, so it is tested with a
 * minimal structural fake — it only reads `headers` and `url`.
 */
const fakeRequest = (
	headers: Record<string, string | undefined>,
	url = "/v2/integrations/planetscale/connect",
): HttpServerRequest.HttpServerRequest => ({ headers, url }) as HttpServerRequest.HttpServerRequest

/**
 * The resolver is UNTRUSTED by design: `x-forwarded-host` is client-supplied on
 * any path that does not strip it, so these cases pin what the resolver *reads*,
 * not what the OAuth flow is allowed to use. `isTrustedCallbackOrigin` (below)
 * is the security boundary — every one of these origins still has to clear it.
 */
describe("resolveRequestOrigin (untrusted — reflects client-controlled headers)", () => {
	it("reflects x-forwarded-host and x-forwarded-proto when both are present", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({
				"x-forwarded-host": "api.maple.dev",
				"x-forwarded-proto": "https",
				host: "internal:8787",
			}),
		)
		assert.strictEqual(origin, "https://api.maple.dev")
	})

	it("prefers the forwarded host over the direct host header — including a spoofed one", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({ "x-forwarded-host": "public.example.com", host: "10.0.0.5:8080" }),
		)
		// Reflected, not accepted: `isTrustedCallbackOrigin` rejects this origin.
		assert.strictEqual(origin, "https://public.example.com")
	})

	it("respects a forwarded proto of http even for a non-localhost host", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({ "x-forwarded-host": "api.maple.dev", "x-forwarded-proto": "http" }),
		)
		assert.strictEqual(origin, "http://api.maple.dev")
	})

	it("falls back to the host header and defaults to https for non-local hosts", () => {
		const origin = resolveRequestOrigin(fakeRequest({ host: "api.maple.dev" }))
		assert.strictEqual(origin, "https://api.maple.dev")
	})

	it("defaults to http for localhost and 127.* hosts, preserving the port", () => {
		assert.strictEqual(
			resolveRequestOrigin(fakeRequest({ host: "localhost:3472" })),
			"http://localhost:3472",
		)
		assert.strictEqual(
			resolveRequestOrigin(fakeRequest({ host: "127.0.0.1:3472" })),
			"http://127.0.0.1:3472",
		)
		assert.strictEqual(resolveRequestOrigin(fakeRequest({ host: "localhost" })), "http://localhost")
	})

	it("preserves an explicit port on a non-local host", () => {
		const origin = resolveRequestOrigin(fakeRequest({ host: "api.maple.dev:8443" }))
		assert.strictEqual(origin, "https://api.maple.dev:8443")
	})

	it("falls back to parsing an absolute request url when no host headers exist", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({}, "https://api.example.com:8443/v2/integrations/planetscale"),
		)
		assert.strictEqual(origin, "https://api.example.com:8443")
	})

	it("returns an empty origin when no host is known and the url is relative", () => {
		const origin = resolveRequestOrigin(fakeRequest({}, "/v2/integrations/planetscale/connect"))
		assert.strictEqual(origin, "")
	})
})

/**
 * The security boundary for an OAuth callback origin: the resolved origin is
 * persisted and replayed as `redirect_uri`, so only the deploy's configured
 * origins (plus its own preview hosts, or local hosts in development) pass.
 */
const production = {
	MAPLE_APP_BASE_URL: "https://app.maple.dev",
	MAPLE_API_BASE_URL: "https://api.maple.dev",
	MAPLE_ENVIRONMENT: "production",
}
const preview = {
	MAPLE_APP_BASE_URL: "https://app-pr-12.maple.dev",
	MAPLE_API_BASE_URL: "https://api-pr-12.maple.dev",
	MAPLE_ENVIRONMENT: "pr-12",
}
const development = {
	MAPLE_APP_BASE_URL: "https://web.localhost",
	MAPLE_API_BASE_URL: "https://api.localhost",
	MAPLE_ENVIRONMENT: "development",
}

describe("isTrustedCallbackOrigin", () => {
	it("accepts the configured app and API origins", () => {
		for (const [origin, config] of [
			["https://api.maple.dev", production],
			["https://app.maple.dev", production],
			["https://api.maple.dev/", production],
			["http://api.maple.internal", { ...production, MAPLE_API_BASE_URL: "http://api.maple.internal" }],
		] as const) {
			assert.isTrue(isTrustedCallbackOrigin(origin, config), origin)
		}
	})

	it("accepts a preview's own hosts only on that preview deploy", () => {
		assert.isTrue(isTrustedCallbackOrigin("https://api-pr-12.maple.dev", preview))
		assert.isTrue(isTrustedCallbackOrigin("https://app-pr-12.maple.dev", preview))
		assert.isFalse(isTrustedCallbackOrigin("https://api-pr-13.maple.dev", preview))
		assert.isFalse(isTrustedCallbackOrigin("https://api-pr-12.maple.dev", production))
	})

	it("accepts local hosts only in development with a local app origin", () => {
		for (const origin of ["https://api.localhost", "https://wt.api.localhost", "http://127.0.0.1:3472"]) {
			assert.isTrue(isTrustedCallbackOrigin(origin, development), origin)
			assert.isFalse(isTrustedCallbackOrigin(origin, production), origin)
		}
		assert.isFalse(
			isTrustedCallbackOrigin("https://api.localhost", {
				...production,
				MAPLE_ENVIRONMENT: "development",
			}),
		)
	})

	it("rejects sibling lookalikes, spoofed forwarded hosts and scheme downgrades", () => {
		for (const [origin, config] of [
			["https://evil.maple.dev", production],
			["https://app-pr-1.maple.dev", production],
			["https://evil.maple.dev", preview],
			["https://public.example.com", production],
			["https://api.maple.dev.evil.com", production],
			["https://api.maple.dev:8443", production],
			["", production],
			["javascript:alert(1)", production],
			["http://api.maple.dev", production],
			["https://evil.localhost", production],
			["https://api.maple.dev", development],
		] as const) {
			assert.isFalse(isTrustedCallbackOrigin(origin, config), origin)
		}
	})
})
