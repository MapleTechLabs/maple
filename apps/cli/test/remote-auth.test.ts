import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, strictEqual } from "node:assert"
import { Clock, Effect, Result, Array as Arr, String as Str } from "effect"
import { HttpClientRequest } from "effect/http"
import { withLocalAccessToken } from "../src/core/local-access"
import {
	accessDenied,
	hasValidSession,
	issueSession,
	LoginThrottle,
	remoteAuthFromEnv,
	throttleClientKey,
	type RemoteAuth,
	safeNextPath,
	SESSION_COOKIE,
	SESSION_TTL_MS,
	sessionValid,
} from "@maple/local-server/remote-auth"
import { __testables, isBrowserOriginAllowed, makeBrowserOriginPolicy } from "@maple/local-server/serve"

const INGEST_KEY = "ingest-key-0123456789abcdef"
const ACCESS_TOKEN = "access-token-0123456789abcdef"
const CREDENTIALS = { maintenanceToken: Str.repeat(64)("m"), consumerToken: Str.repeat(64)("c") }
const BOTH: RemoteAuth = { ingestKey: INGEST_KEY, accessToken: ACCESS_TOKEN }
const NOW = 1_800_000_000_000

const request = (path: string, init: RequestInit = {}) => {
	const req = new Request(`http://maple.example.com${path}`, init)
	return { req, url: new URL(req.url) }
}

const attemptsFrom = (client: string, throttle = new LoginThrottle()) => ({ throttle, client })

const decide = (
	auth: RemoteAuth,
	path: string,
	init: RequestInit = {},
	attempts = attemptsFrom("10.0.0.1"),
) => {
	const { req, url } = request(path, init)
	return accessDenied(auth, CREDENTIALS, req, url, NOW, attempts)
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

	it("throttles failed Bearer tokens per client, before the compare", () => {
		const throttle = new LoginThrottle(2, 3, 60_000)
		const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })
		const from = (client: string, token: string) =>
			decide(BOTH, "/local/status", bearer(token), attemptsFrom(client, throttle))?.status ?? 200
		deepStrictEqual(
			Arr.map(["wrong-1", "wrong-2", ACCESS_TOKEN], (token) => from("10.0.0.1", token)),
			[401, 401, 429],
		)
		// Another client is not locked out by the first one's guesses.
		strictEqual(from("10.0.0.2", ACCESS_TOKEN), 200)
		// A third failure anywhere reaches the server-wide ceiling.
		strictEqual(from("10.0.0.2", "wrong-3"), 401)
		strictEqual(from("10.0.0.3", ACCESS_TOKEN), 429)
		// A session cookie is not a guess and never throttled.
		const cookie = `${SESSION_COOKIE}=${issueSession(ACCESS_TOKEN, NOW)}`
		strictEqual(
			decide(BOTH, "/local/status", { headers: { cookie } }, attemptsFrom("10.0.0.1", throttle)),
			null,
		)
	})

	it("answers other /v1 routes 404 without counting an SDK's ingest key as a guess", () => {
		const throttle = new LoginThrottle(1, 100, 60_000)
		const events = { method: "POST", headers: { authorization: `Bearer ${INGEST_KEY}` } }
		strictEqual(decide(BOTH, "/v1/events", events, attemptsFrom("10.0.0.1", throttle))?.status, 404)
		strictEqual(decide(BOTH, "/v1/events", events, attemptsFrom("10.0.0.1", throttle))?.status, 404)
		strictEqual(throttle.retryAfterMs("10.0.0.1", NOW), 0)
	})

	it("keys throttled clients by IPv4 address and by IPv6 /64", () => {
		strictEqual(throttleClientKey("203.0.113.7"), "203.0.113.7")
		strictEqual(throttleClientKey("::ffff:203.0.113.7"), "203.0.113.7")
		strictEqual(throttleClientKey("2001:db8:a:b:1:2:3:4"), "2001:db8:a:b::/64")
		strictEqual(throttleClientKey("2001:db8:a:b::9"), "2001:db8:a:b::/64")
		strictEqual(throttleClientKey("2001:0db8::1"), "2001:db8:0:0::/64")
		strictEqual(throttleClientKey("::1"), "0:0:0:0::/64")
		strictEqual(throttleClientKey("fe80::1%en0"), "fe80:0:0:0::/64")
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
		const [expiry, signature] = Str.split(".")(issueSession(ACCESS_TOKEN, NOW))
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
			const response = yield* __testables.loginSpan(BOTH, attemptsFrom("10.0.0.1"), req, url)
			strictEqual(response.status, 303)
			strictEqual(response.headers.get("location"), "/traces")
			const setCookie = response.headers.get("set-cookie") ?? ""
			ok(
				Str.includes("HttpOnly")(setCookie) &&
					Str.includes("Secure")(setCookie) &&
					Str.includes("SameSite=Lax")(setCookie),
			)
			const cookie = Str.split(";")(setCookie)[0] ?? ""
			const nowMs = yield* Clock.currentTimeMillis
			ok(
				hasValidSession(
					BOTH,
					new Request("http://maple.example.com/", { headers: { cookie } }),
					nowMs,
				),
			)
		}),
	)

	it.effect("answers a wrong token with 401 and throttles that client after repeated failures", () =>
		Effect.gen(function* () {
			const throttle = new LoginThrottle(2, 100, 60_000)
			const wrong = yield* Effect.forEach([1, 2], () => {
				const { req, url } = form("wrong-token-0123456789abcdef")
				return __testables.loginSpan(BOTH, attemptsFrom("10.0.0.1", throttle), req, url)
			})
			deepStrictEqual(
				Arr.map(wrong, (response) => response.status),
				[401, 401],
			)
			const own = form(ACCESS_TOKEN)
			const throttled = yield* __testables.loginSpan(
				BOTH,
				attemptsFrom("10.0.0.1", throttle),
				own.req,
				own.url,
			)
			strictEqual(throttled.status, 429)
			ok(Number(throttled.headers.get("retry-after")) > 0)
			// Someone else's failures do not lock this client out.
			const other = form(ACCESS_TOKEN)
			const signedIn = yield* __testables.loginSpan(
				BOTH,
				attemptsFrom("10.0.0.2", throttle),
				other.req,
				other.url,
			)
			strictEqual(signedIn.status, 303)
		}),
	)

	it.effect("holds the limit when failed attempts arrive in parallel", () =>
		Effect.gen(function* () {
			const throttle = new LoginThrottle(2, 100, 60_000)
			const responses = yield* Effect.forEach(
				[1, 2, 3, 4, 5, 6, 7],
				() => {
					const { req, url } = form("wrong-token-0123456789abcdef")
					return __testables.loginSpan(BOTH, attemptsFrom("10.0.0.1", throttle), req, url)
				},
				{ concurrency: "unbounded" },
			)
			deepStrictEqual(
				Arr.map(responses, (response) => response.status).sort(),
				[401, 401, 429, 429, 429, 429, 429],
			)
		}),
	)

	it("lets the throttle recover once failures leave the window", () => {
		const throttle = new LoginThrottle(2, 100, 60_000)
		throttle.recordFailure("10.0.0.1", NOW)
		throttle.recordFailure("10.0.0.1", NOW + 1)
		strictEqual(throttle.retryAfterMs("10.0.0.1", NOW + 2), 59_998)
		strictEqual(throttle.retryAfterMs("10.0.0.2", NOW + 2), 0)
		strictEqual(throttle.retryAfterMs("10.0.0.1", NOW + 60_001), 0)
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

	it("accepts an Origin-less request on any Host, since the token then guards every read", () => {
		ok(isBrowserOriginAllowed(url, null, policy(true)))
		ok(!isBrowserOriginAllowed(url, null, policy(false)))
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

	it("never sends it over http to an https target", () => {
		strictEqual(
			authorization(HttpClientRequest.get("http://maple.example.com:8080/local/status")),
			undefined,
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
