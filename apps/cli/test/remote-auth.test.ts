import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, strictEqual } from "node:assert"
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

	it("lets an event consumer's token open only the claim and ack routes", () => {
		const headers = { "x-maple-event-consumer-token": CREDENTIALS.consumerToken }
		strictEqual(decide(BOTH, "/local/eventing/acks", { method: "POST", headers }), null)
		strictEqual(decide(BOTH, "/local/query", { method: "POST", headers })?.status, 401)
		strictEqual(decide(BOTH, "/", { headers })?.status, 303)
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
			const wrong = yield* Effect.forEach([1, 2], () => {
				const { req, url } = form("wrong-token-0123456789abcdef")
				return __testables.loginSpan(BOTH, throttle, req, url)
			})
			deepStrictEqual(
				wrong.map((response) => response.status),
				[401, 401],
			)
			const { req, url } = form(ACCESS_TOKEN)
			const throttled = yield* __testables.loginSpan(BOTH, throttle, req, url)
			strictEqual(throttled.status, 429)
			ok(Number(throttled.headers.get("retry-after")) > 0)
		}),
	)

	it.effect("holds the limit when failed attempts arrive in parallel", () =>
		Effect.gen(function* () {
			const throttle = new LoginThrottle(2, 60_000)
			const responses = yield* Effect.forEach(
				[1, 2, 3, 4, 5, 6, 7],
				() => {
					const { req, url } = form("wrong-token-0123456789abcdef")
					return __testables.loginSpan(BOTH, throttle, req, url)
				},
				{ concurrency: "unbounded" },
			)
			deepStrictEqual(
				responses.map((response) => response.status).sort(),
				[401, 401, 429, 429, 429, 429, 429],
			)
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
		strictEqual(safeNextPath("/\t/evil.example"), "/")
		strictEqual(safeNextPath("/\n/evil.example"), "/")
		strictEqual(safeNextPath("/%5C/evil.example"), "/%5C/evil.example")
		strictEqual(safeNextPath("/.//evil.example"), "/.//evil.example")
		strictEqual(safeNextPath("/\u3000/x"), "/")
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

	it("keeps OTLP ingest to advertised hosts, which the access token does not guard", () => {
		const ingest = new URL("http://rebound.example/v1/traces")
		ok(!isBrowserOriginAllowed(ingest, "http://rebound.example", policy(true)))
	})
})

describe("CLI access token", () => {
	const sign = withLocalAccessToken(ACCESS_TOKEN, "https://maple.example.com")
	const authorization = (request: HttpClientRequest.HttpClientRequest) =>
		sign(request).headers.authorization

	it("is sent to /local/* on the MAPLE_LOCAL_URL origin and on loopback", () => {
		strictEqual(
			authorization(HttpClientRequest.post("https://maple.example.com/local/query")),
			`Bearer ${ACCESS_TOKEN}`,
		)
		strictEqual(
			authorization(HttpClientRequest.get("http://127.0.0.1:4318/local/status")),
			`Bearer ${ACCESS_TOKEN}`,
		)
	})

	it("reaches a server bound to one of this machine's own addresses", () => {
		const onThisMachine = withLocalAccessToken(
			ACCESS_TOKEN,
			"http://127.0.0.1:4318",
			new Set(["192.168.1.5"]),
		)
		strictEqual(
			onThisMachine(HttpClientRequest.get("http://192.168.1.5:4318/local/status")).headers
				.authorization,
			`Bearer ${ACCESS_TOKEN}`,
		)
		strictEqual(
			onThisMachine(HttpClientRequest.get("http://192.168.1.6:4318/local/status")).headers
				.authorization,
			undefined,
		)
	})

	it("follows the target host to a discovered port", () => {
		strictEqual(
			authorization(HttpClientRequest.get("https://maple.example.com:4319/local/status")),
			`Bearer ${ACCESS_TOKEN}`,
		)
	})

	it("never reaches another host or route", () => {
		strictEqual(authorization(HttpClientRequest.get("https://other.example/local/status")), undefined)
		strictEqual(authorization(HttpClientRequest.get("https://maple.example.com/health")), undefined)
		strictEqual(
			authorization(HttpClientRequest.get("https://api.github.com/repos/x/releases")),
			undefined,
		)
	})
})
