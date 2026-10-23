import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { Effect, Result } from "effect"
import { HttpClientRequest } from "effect/http"
import { withLocalAccessToken } from "../src/core/local-access"
import {
	accessDenied,
	hasValidSession,
	issueSession,
	LoginThrottle,
	remoteAuthFromEnv,
	type RemoteAuth,
	safeNextPath,
	SESSION_COOKIE,
	SESSION_TTL_MS,
	sessionValid,
} from "../src/server/remote-auth"
import { __testables, isBrowserOriginAllowed, makeBrowserOriginPolicy } from "../src/server/serve"

const INGEST_KEY = "ingest-key-0123456789abcdef"
const ACCESS_TOKEN = "access-token-0123456789abcdef"
const CREDENTIALS = { maintenanceToken: "m".repeat(64), consumerToken: "c".repeat(64) }
const BOTH: RemoteAuth = { ingestKey: INGEST_KEY, accessToken: ACCESS_TOKEN }
const NOW = 1_800_000_000_000

const request = (path: string, init: RequestInit = {}) => {
	const req = new Request(`http://maple.example.com${path}`, init)
	return { req, url: new URL(req.url) }
}

const decide = (auth: RemoteAuth, path: string, init: RequestInit = {}) => {
	const { req, url } = request(path, init)
	return accessDenied(auth, CREDENTIALS, req, url, NOW)
}

describe("remote auth configuration", () => {
	it("treats unset and blank secrets as off", () => {
		const auth = remoteAuthFromEnv({ MAPLE_LOCAL_INGEST_KEY: "  " })
		ok(Result.isSuccess(auth))
		strictEqual(auth.success.ingestKey, undefined)
		strictEqual(auth.success.accessToken, undefined)
	})

	it("rejects a secret shorter than 16 characters and names the variable", () => {
		const auth = remoteAuthFromEnv({ MAPLE_LOCAL_ACCESS_TOKEN: "hunter2" })
		ok(Result.isFailure(auth))
		strictEqual(auth.failure.source, "MAPLE_LOCAL_ACCESS_TOKEN")
	})
})

describe("ingest key", () => {
	it("refuses OTLP without the key, with a wrong key, and with the access token", () => {
		strictEqual(decide(BOTH, "/v1/traces", { method: "POST" })?.status, 401)
		strictEqual(
			decide(BOTH, "/v1/logs", {
				method: "POST",
				headers: { authorization: "Bearer wrong-key-0123456789" },
			})?.status,
			401,
		)
		strictEqual(
			decide(BOTH, "/v1/metrics", {
				method: "POST",
				headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
			})?.status,
			401,
		)
	})

	it("accepts the key as a Bearer token or as x-maple-ingest-key", () => {
		strictEqual(
			decide(BOTH, "/v1/traces", {
				method: "POST",
				headers: { authorization: `Bearer ${INGEST_KEY}` },
			}),
			null,
		)
		strictEqual(
			decide(BOTH, "/v1/traces", { method: "POST", headers: { "x-maple-ingest-key": INGEST_KEY } }),
			null,
		)
	})

	it("never grants a read", () => {
		const headers = { authorization: `Bearer ${INGEST_KEY}` }
		strictEqual(decide(BOTH, "/local/query", { method: "POST", headers })?.status, 401)
		strictEqual(decide(BOTH, "/local/status", { headers })?.status, 401)
	})

	it("leaves ingest open when only the access token is set", () => {
		strictEqual(
			decide({ ingestKey: undefined, accessToken: ACCESS_TOKEN }, "/v1/traces", { method: "POST" }),
			null,
		)
	})
})

describe("access token", () => {
	it("sends an unauthenticated page load to the sign-in page and an API call a 401", () => {
		const page = decide(BOTH, "/")
		strictEqual(page?.status, 303)
		strictEqual(page?.headers.get("location"), "/login")
		strictEqual(decide(BOTH, "/local/status")?.status, 401)
		strictEqual(decide(BOTH, "/local/query", { method: "POST" })?.status, 401)
	})

	it("keeps /health and the sign-in routes open", () => {
		strictEqual(decide(BOTH, "/health"), null)
		strictEqual(decide(BOTH, "/login"), null)
		strictEqual(decide(BOTH, "/local/auth/login", { method: "POST" }), null)
	})

	it("admits a session cookie, the Bearer token, and the server's own machine tokens", () => {
		const cookie = `${SESSION_COOKIE}=${issueSession(ACCESS_TOKEN, NOW)}`
		strictEqual(decide(BOTH, "/local/query", { method: "POST", headers: { cookie } }), null)
		strictEqual(
			decide(BOTH, "/local/status", { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } }),
			null,
		)
		strictEqual(
			decide(BOTH, "/local/query", {
				method: "POST",
				headers: { "x-maple-maintenance-token": CREDENTIALS.maintenanceToken },
			}),
			null,
		)
		strictEqual(
			decide(BOTH, "/local/eventing/claims", {
				method: "POST",
				headers: { "x-maple-event-consumer-token": CREDENTIALS.consumerToken },
			}),
			null,
		)
	})

	it("leaves reads open when no access token is configured", () => {
		strictEqual(
			decide({ ingestKey: INGEST_KEY, accessToken: undefined }, "/local/query", { method: "POST" }),
			null,
		)
	})
})

describe("sessions", () => {
	it("expire after the TTL", () => {
		const session = issueSession(ACCESS_TOKEN, NOW)
		ok(sessionValid(ACCESS_TOKEN, session, NOW + SESSION_TTL_MS - 1))
		ok(!sessionValid(ACCESS_TOKEN, session, NOW + SESSION_TTL_MS))
	})

	it("reject a tampered expiry and a rotated access token", () => {
		const [expiry, signature] = issueSession(ACCESS_TOKEN, NOW).split(".")
		ok(!sessionValid(ACCESS_TOKEN, `${Number(expiry) + SESSION_TTL_MS}.${signature}`, NOW))
		ok(!sessionValid("rotated-token-0123456789abcdef", `${expiry}.${signature}`, NOW))
		ok(!sessionValid(ACCESS_TOKEN, "garbage", NOW))
	})
})

describe("sign-in", () => {
	const form = (token: string, next = "/") =>
		request("/local/auth/login", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
			body: new URLSearchParams({ token, next }).toString(),
		})

	it.live("sets a session cookie that the access check accepts and returns to `next`", () =>
		Effect.gen(function* () {
			const { req, url } = form(ACCESS_TOKEN, "/traces")
			const response = yield* __testables.loginSpan(BOTH, new LoginThrottle(), req, url)
			strictEqual(response.status, 303)
			strictEqual(response.headers.get("location"), "/traces")
			const setCookie = response.headers.get("set-cookie") ?? ""
			ok(
				setCookie.includes("HttpOnly") &&
					setCookie.includes("Secure") &&
					setCookie.includes("SameSite=Lax"),
			)
			const cookie = setCookie.split(";")[0] ?? ""
			ok(
				hasValidSession(
					BOTH,
					new Request("http://maple.example.com/", { headers: { cookie } }),
					Date.now(),
				),
			)
		}),
	)

	it.effect("answers a wrong token with 401 and throttles after repeated failures", () =>
		Effect.gen(function* () {
			const throttle = new LoginThrottle(2, 60_000)
			for (const _ of [1, 2]) {
				const { req, url } = form("wrong-token-0123456789abcdef")
				strictEqual((yield* __testables.loginSpan(BOTH, throttle, req, url)).status, 401)
			}
			const { req, url } = form(ACCESS_TOKEN)
			const throttled = yield* __testables.loginSpan(BOTH, throttle, req, url)
			strictEqual(throttled.status, 429)
			ok(Number(throttled.headers.get("retry-after")) > 0)
		}),
	)

	it("lets the throttle recover once failures leave the window", () => {
		const throttle = new LoginThrottle(2, 60_000)
		throttle.recordFailure(NOW)
		throttle.recordFailure(NOW + 1)
		ok(throttle.retryAfterMs(NOW + 2) > 0)
		strictEqual(throttle.retryAfterMs(NOW + 60_001), 0)
	})

	it("only follows same-site paths after sign-in", () => {
		strictEqual(safeNextPath("/traces?x=1"), "/traces?x=1")
		strictEqual(safeNextPath("//evil.example"), "/")
		strictEqual(safeNextPath("/\\evil.example"), "/")
		strictEqual(safeNextPath("https://evil.example"), "/")
		strictEqual(safeNextPath(null), "/")
	})
})

describe("browser origins with an access token", () => {
	const policy = (anySameOriginHost: boolean) => {
		const result = makeBrowserOriginPolicy({ browserHosts: ["127.0.0.1"], anySameOriginHost })
		ok(Result.isSuccess(result))
		return result.success
	}
	const url = new URL("http://maple.up.example.app/local/query")

	it("accepts same-origin from an unadvertised platform hostname", () => {
		ok(!isBrowserOriginAllowed(url, "http://maple.up.example.app", policy(false)))
		ok(isBrowserOriginAllowed(url, "http://maple.up.example.app", policy(true)))
	})

	it("still refuses other origins", () => {
		ok(!isBrowserOriginAllowed(url, "http://evil.example", policy(true)))
	})
})

describe("CLI access token", () => {
	it("is sent to /local/* routes only", () => {
		const sign = withLocalAccessToken(ACCESS_TOKEN)
		strictEqual(
			sign(HttpClientRequest.post("https://maple.example.com/local/query")).headers.authorization,
			`Bearer ${ACCESS_TOKEN}`,
		)
		strictEqual(
			sign(HttpClientRequest.get("https://api.github.com/repos/x/releases")).headers.authorization,
			undefined,
		)
	})
})
