import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientError } from "effect/http"
import {
	describeHttpClientError,
	guard,
	parseExternalUrl,
	UrlValidationError,
	validateExternalUrl,
} from "./index"

const rejects = (raw: string) => Result.isFailure(parseExternalUrl(raw))

describe("parseExternalUrl", () => {
	it("accepts public https URLs", () => {
		const url = Result.getOrThrow(parseExternalUrl("https://api.example.com/probe"))
		expect(url.hostname).toBe("api.example.com")
	})

	it("accepts public http URLs", () => {
		const url = Result.getOrThrow(parseExternalUrl("http://prom.public.dev:9090/metrics"))
		expect(url.hostname).toBe("prom.public.dev")
	})

	it.each(["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "data:text/html,<script>"])(
		"rejects non-http(s) scheme: %s",
		(raw) => {
			expect(rejects(raw)).toBe(true)
		},
	)

	it.each([
		"http://localhost",
		"http://localhost.localdomain",
		"http://127.0.0.1",
		"http://127.0.0.99/api",
		"http://0.0.0.0",
		"http://10.0.0.1",
		"http://192.168.1.1",
		"http://172.16.0.1",
		"http://172.31.255.255",
		"http://169.254.169.254/latest/meta-data/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://[::1]/",
		"http://[fe80::1]/",
		"http://[fc00::1]/",
		"http://[fd12:3456:789a::1]/",
		// IPv4-mapped IPv6: most URL parsers canonicalise these to the hex
		// form (e.g. `[::ffff:7f00:1]` for 127.0.0.1), so match both forms.
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[::ffff:10.0.0.1]/",
		"http://[::ffff:192.168.1.1]/",
		"http://[::ffff:172.20.0.1]/",
		// A trailing dot is the same name fully qualified, but the URL parser keeps
		// it, so a blocklist keyed on the bare name used to miss it entirely.
		"http://localhost./",
		"http://metadata.google.internal./computeMetadata/v1/",
		// Link-local is fe80::/10, not fe80::/16 — everything up to febf: is in range.
		"http://[fe9f::1]/",
		"http://[fea0::1]/",
		"http://[febf::1]/",
		// Deprecated site-local, still routed on plenty of internal networks.
		"http://[fec0::1]/",
		// Transition mechanisms delivering to an embedded IPv4 address.
		"http://[2002:7f00:1::]/",
		"http://[64:ff9b::7f00:1]/",
		"http://[64:ff9b::169.254.169.254]/",
		// Oracle Cloud metadata, documentation ranges, multicast and reserved.
		"http://192.0.0.192/opc/v1/instance/",
		"http://192.0.2.1/",
		"http://198.51.100.1/",
		"http://203.0.113.1/",
		"http://224.0.0.1/",
		"http://239.255.255.250/",
		"http://240.0.0.1/",
	])("rejects private/loopback host: %s", (raw) => {
		expect(rejects(raw)).toBe(true)
	})

	// The parser's host here is `internal`, not `real.example.com` — the credentials
	// hide the real destination from anyone eyeballing the stored URL.
	it.each(["https://real.example.com@localhost/", "https://user:pw@api.example.com/"])(
		"rejects embedded credentials: %s",
		(raw) => {
			expect(rejects(raw)).toBe(true)
		},
	)

	// Public addresses that merely sit near a blocked range must still pass, or
	// the widened patterns would start rejecting legitimate destinations.
	it.each([
		"https://api.example.com./webhook",
		"http://100.63.255.255/",
		"http://100.128.0.1/",
		"http://192.0.1.1/",
		"http://192.1.0.1/",
		"http://198.20.0.1/",
		"http://223.255.255.255/",
		"http://[2001:db8::1]/",
		"http://[2002::1]/",
		// Hostnames that merely start like a blocked range. The IPv4 patterns are
		// prefix matches, so they are only applied to actual address literals.
		"https://10.example.com/hook",
		"https://240.example.com/hook",
		"https://127.acme.io/hook",
		"https://192.168.example.com/hook",
	])("accepts public host: %s", (raw) => {
		expect(rejects(raw)).toBe(false)
	})

	it("rejects empty string", () => {
		expect(rejects("")).toBe(true)
		expect(rejects("   ")).toBe(true)
	})

	it("rejects malformed input", () => {
		expect(rejects("not a url")).toBe(true)
	})
})

describe("validateExternalUrl (Effect)", () => {
	it.effect("succeeds for a public URL", () =>
		Effect.gen(function* () {
			const url = yield* validateExternalUrl("https://hooks.slack.com/services/abc")
			assert.strictEqual(url.hostname, "hooks.slack.com")
		}),
	)

	it.effect("fails with UrlValidationError for a private URL", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(validateExternalUrl("http://169.254.169.254"))
			assert.instanceOf(error, UrlValidationError)
		}),
	)
})

/** A guarded client whose transport is `fakeFetch`. */
const run = <A, E>(
	fakeFetch: typeof fetch,
	use: (
		client: HttpClient.HttpClient.With<HttpClientError.HttpClientError | UrlValidationError>,
	) => Effect.Effect<A, E>,
) =>
	Effect.flatMap(HttpClient.HttpClient, (client) => use(guard(client))).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
	)

const urlOf = (input: string | URL | Request) => (input instanceof Request ? input.url : String(input))

describe("guard", () => {
	it.effect("issues the request when the URL is public, with redirect: manual", () =>
		Effect.gen(function* () {
			const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
			const fakeFetch: typeof fetch = async (input, init) => {
				calls.push({ url: urlOf(input), redirect: init?.redirect })
				return new Response("ok", { status: 200 })
			}
			const response = yield* run(fakeFetch, (client) => client.get("https://api.example.com/x"))
			assert.strictEqual(response.status, 200)
			assert.deepStrictEqual(calls, [{ url: "https://api.example.com/x", redirect: "manual" }])
		}),
	)

	it.effect("rejects an internal URL before fetching", () =>
		Effect.gen(function* () {
			let calls = 0
			const fakeFetch: typeof fetch = async () => {
				calls++
				return new Response("ok")
			}
			const error = yield* Effect.flip(
				run(fakeFetch, (client) => client.get("http://169.254.169.254/")),
			)
			assert.instanceOf(error, UrlValidationError)
			assert.strictEqual(calls, 0)
		}),
	)

	it.effect("validates query params added outside the URL string", () =>
		Effect.gen(function* () {
			const seen: Array<string> = []
			const fakeFetch: typeof fetch = async (input) => {
				seen.push(urlOf(input))
				return new Response("ok")
			}
			yield* run(fakeFetch, (client) =>
				client.get("https://api.example.com/metrics", { urlParams: { sig: "s" } }),
			)
			assert.deepStrictEqual(seen, ["https://api.example.com/metrics?sig=s"])
		}),
	)

	it.effect("rejects a redirect to an internal URL", () =>
		Effect.gen(function* () {
			let calls = 0
			const fakeFetch: typeof fetch = async () => {
				calls++
				return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
			}
			const error = yield* Effect.flip(
				run(fakeFetch, (client) => client.get("https://api.example.com/x")),
			)
			assert.instanceOf(error, UrlValidationError)
			assert.strictEqual(calls, 1)
		}),
	)

	it.effect("follows a redirect to another public URL, keeping method and body", () =>
		Effect.gen(function* () {
			const seen: Array<{ url: string; method: string | undefined; body: string }> = []
			const fakeFetch: typeof fetch = async (input, init) => {
				seen.push({ url: urlOf(input), method: init?.method, body: String(init?.body ?? "") })
				return seen.length === 1
					? new Response(null, { status: 307, headers: { location: "https://api2.example.com/y" } })
					: new Response("ok", { status: 200 })
			}
			const response = yield* run(fakeFetch, (client) =>
				client.post("https://api1.example.com/x", { body: HttpBody.text("payload") }),
			)
			assert.strictEqual(response.status, 200)
			assert.deepStrictEqual(
				seen.map((s) => [s.url, s.method, s.body]),
				[
					["https://api1.example.com/x", "POST", "payload"],
					["https://api2.example.com/y", "POST", "payload"],
				],
			)
		}),
	)

	it.effect("drops credential headers on a cross-origin redirect", () =>
		Effect.gen(function* () {
			const seen: Array<string | null> = []
			const fakeFetch: typeof fetch = async (_url, init) => {
				seen.push(new Headers(init?.headers).get("authorization"))
				return seen.length === 1
					? new Response(null, {
							status: 302,
							headers: { location: "https://attacker.example/steal" },
						})
					: new Response("ok", { status: 200 })
			}
			const response = yield* run(fakeFetch, (client) =>
				client.get("https://api.example.com/metrics", {
					headers: { Authorization: "Bearer scrape-secret", Accept: "text/plain" },
				}),
			)
			assert.strictEqual(response.status, 200)
			assert.deepStrictEqual(seen, ["Bearer scrape-secret", null])
		}),
	)

	it.effect("keeps credential headers on a same-origin redirect", () =>
		Effect.gen(function* () {
			const seen: Array<string | null> = []
			const fakeFetch: typeof fetch = async (_url, init) => {
				seen.push(new Headers(init?.headers).get("authorization"))
				return seen.length === 1
					? new Response(null, { status: 302, headers: { location: "/metrics/v2" } })
					: new Response("ok", { status: 200 })
			}
			yield* run(fakeFetch, (client) =>
				client.get("https://api.example.com/metrics", {
					headers: { Authorization: "Bearer scrape-secret" },
				}),
			)
			assert.deepStrictEqual(seen, ["Bearer scrape-secret", "Bearer scrape-secret"])
		}),
	)

	it.effect("does not restore credentials when a redirect bounces back to the original origin", () =>
		Effect.gen(function* () {
			const seen: Array<string | null> = []
			const hops = ["https://attacker.example/a", "https://api.example.com/back"]
			const fakeFetch: typeof fetch = async (_url, init) => {
				seen.push(new Headers(init?.headers).get("authorization"))
				const location = hops[seen.length - 1]
				return location === undefined
					? new Response("ok", { status: 200 })
					: new Response(null, { status: 302, headers: { location } })
			}
			yield* run(fakeFetch, (client) =>
				client.get("https://api.example.com/metrics", {
					headers: { Authorization: "Bearer scrape-secret" },
				}),
			)
			assert.deepStrictEqual(seen, ["Bearer scrape-secret", null, null])
		}),
	)

	it.effect("a redirect's query replaces the original request's params", () =>
		Effect.gen(function* () {
			const seen: Array<string> = []
			const fakeFetch: typeof fetch = async (input) => {
				seen.push(urlOf(input))
				return seen.length === 1
					? new Response(null, { status: 302, headers: { location: "/next?token=new" } })
					: new Response("ok", { status: 200 })
			}
			yield* run(fakeFetch, (client) =>
				client.get("https://api.example.com/start", { urlParams: { token: "old" } }),
			)
			assert.deepStrictEqual(seen, [
				"https://api.example.com/start?token=old",
				"https://api.example.com/next?token=new",
			])
		}),
	)

	it.effect("returns a redirect with an empty Location instead of re-requesting", () =>
		Effect.gen(function* () {
			let calls = 0
			const fakeFetch: typeof fetch = async () => {
				calls++
				return new Response(null, { status: 302, headers: { location: "" } })
			}
			const response = yield* run(fakeFetch, (client) => client.post("https://api.example.com/hook"))
			assert.strictEqual(response.status, 302)
			assert.strictEqual(calls, 1)
		}),
	)

	it.effect("under HttpClient.withScope, every hop is aborted when the scope closes", () =>
		Effect.gen(function* () {
			const signals: Array<AbortSignal> = []
			const fakeFetch: typeof fetch = async (_url, init) => {
				if (init?.signal) signals.push(init.signal)
				return signals.length === 1
					? new Response("moved", { status: 302, headers: { location: "/next" } })
					: new Response("unread", { status: 200 })
			}
			yield* Effect.flatMap(HttpClient.HttpClient, (client) =>
				guard(HttpClient.withScope(client)).get("https://api.example.com/start"),
			).pipe(
				Effect.scoped,
				Effect.provide(FetchHttpClient.layer),
				Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
			)
			assert.strictEqual(signals.length, 2)
			assert.isTrue(signals.every((signal) => signal.aborted))
		}),
	)

	it.effect("caps redirect chains", () =>
		Effect.gen(function* () {
			let calls = 0
			const fakeFetch: typeof fetch = async () => {
				calls++
				return new Response(null, {
					status: 302,
					headers: { location: `https://api${calls}.example.com/r` },
				})
			}
			const error = yield* Effect.flip(
				run(fakeFetch, (client) => client.get("https://api0.example.com/r")),
			)
			assert.instanceOf(error, UrlValidationError)
			assert.strictEqual(calls, 6)
		}),
	)

	it.effect("aborts the in-flight request when interrupted", () =>
		Effect.gen(function* () {
			let aborted = false
			const fakeFetch: typeof fetch = (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						aborted = true
						reject(new Error("aborted"))
					})
				})
			const fiber = yield* run(fakeFetch, (client) =>
				client.get("https://api.example.com/slow").pipe(Effect.timeout("10 millis")),
			).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
			yield* TestClock.adjust("10 millis")
			const exit = yield* Fiber.join(fiber)
			assert.isTrue(Exit.isFailure(exit))
			assert.isTrue(aborted)
		}),
	)
})

describe("describeHttpClientError", () => {
	it.effect("redacts the request URL from a transport failure's message", () =>
		Effect.gen(function* () {
			const fakeFetch: typeof fetch = async (input) => {
				throw new TypeError(`connect failed for ${urlOf(input)}`)
			}
			const error = yield* Effect.flip(
				run(fakeFetch, (client) =>
					client.get("https://hooks.example.com/api/webhooks/1/SECRET?sig=SIG"),
				),
			)
			assert.strictEqual(error._tag, "HttpClientError")
			if (error._tag !== "HttpClientError") return
			const message = describeHttpClientError(error)
			assert.strictEqual(message, "connect failed for https://hooks.example.com")
		}),
	)
})
