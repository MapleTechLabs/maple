import { describe, it } from "@effect/vitest"
import { test } from "bun:test"
import { deepStrictEqual, strictEqual } from "node:assert"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Option, Ref, Tracer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { cloudflaredAccessToken, localAccessClient, parseLocalHeaders } from "./local-access"
import { Mode } from "./mode"
import { rawQuery } from "./operations"

interface Sent {
	readonly url: string
	readonly headers: Headers
	readonly redirect: RequestInit["redirect"]
}

/** A fetch that records what it was sent and answers every request with `respond()`. */
const recordingFetch = (respond: () => Response = () => Response.json([])) => {
	const sent: Array<Sent> = []
	const stub = async (input: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect })
		return respond()
	}
	// SAFETY: the client only calls fetch(url, init), which `stub` implements.
	const fetch = stub as unknown as typeof globalThis.fetch
	return {
		sent,
		layer: FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
	}
}

const settings = (localUrl: string, headers: Record<string, string> = {}) =>
	Effect.map(Ref.make(0), (asked) => ({
		asked,
		settings: {
			localUrl,
			accessToken: undefined,
			headers,
			cloudflaredToken: Ref.update(asked, (n) => n + 1).pipe(Effect.as(Option.some("cf-jwt"))),
		},
	}))

const RANGE = { startTime: "2026-10-25 12:00:00", endTime: "2026-10-25 13:00:00" }

describe("parseLocalHeaders", () => {
	it("reads OTLP-style name=value pairs, splitting on the first equals and percent-decoding values", () => {
		deepStrictEqual(
			parseLocalHeaders(
				" CF-Access-Client-Id=id.access , Authorization=Basic%20a=b,NoEquals,=orphan, ",
			),
			{ "cf-access-client-id": "id.access", authorization: "Basic a=b" },
		)
		deepStrictEqual(parseLocalHeaders(undefined), {})
	})
})

/** A stand-in `cloudflared`: a shell script with the given body. */
const stubBinary = (body: string): string => {
	const path = join(mkdtempSync(join(tmpdir(), "maple-cloudflared-")), "cloudflared")
	writeFileSync(path, `#!/bin/sh\n${body}\n`)
	chmodSync(path, 0o755)
	return path
}

/** Runs the lookup and returns the token with the outcome its span recorded. */
const lookup = (binary: string, timeout: number = 5_000) =>
	Effect.gen(function* () {
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		const token = yield* cloudflaredAccessToken("https://maple.example.com", { binary, timeout }).pipe(
			Effect.provide(BunServices.layer),
			Effect.withTracer(tracer),
		)
		const span = spans.find((candidate) => candidate.name === "LocalAccess.cloudflaredToken")
		return { token, outcome: span?.attributes.get("maple.cli.cloudflared.outcome") }
	})

// Plain bun tests: under `bun test`, `it.effect`/`it.live` hang on a body that spawns a real process.
describe("cloudflaredAccessToken", () => {
	test("returns the cached token for the origin, trimmed", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* lookup(
					stubBinary(`[ "$3" = "-app=https://maple.example.com" ] && echo "  jwt  "`),
				)
				deepStrictEqual(result, { token: Option.some("jwt"), outcome: "found" })
			}),
		))

	test("returns no token on a failed exit or empty output", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				deepStrictEqual(yield* lookup(stubBinary("echo jwt; exit 1")), {
					token: Option.none(),
					outcome: "no_token",
				})
				deepStrictEqual(yield* lookup(stubBinary("echo")), {
					token: Option.none(),
					outcome: "no_token",
				})
			}),
		))

	test("gives up on a cloudflared that stalls", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				deepStrictEqual(yield* lookup(stubBinary("sleep 30"), 200), {
					token: Option.none(),
					outcome: "timeout",
				})
			}),
		))

	test("returns no token when cloudflared is not installed", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* lookup(join(tmpdir(), "maple-no-such-cloudflared"))
				deepStrictEqual(result, { token: Option.none(), outcome: "unavailable" })
			}),
		))
})

describe("localAccessClient", () => {
	it.effect("sends the configured headers and one cloudflared token to the server on every path", () =>
		Effect.gen(function* () {
			const { sent, layer } = recordingFetch()
			const { asked, settings: s } = yield* settings("https://maple.example.com", { "x-team": "obs" })
			const client = yield* Effect.flatMap(HttpClient.HttpClient, localAccessClient(s)).pipe(
				Effect.provide(layer),
			)

			yield* client.execute(HttpClientRequest.get("https://maple.example.com/health"))
			yield* client.execute(
				HttpClientRequest.post("https://maple.example.com/local/query").pipe(
					HttpClientRequest.bodyText("{}", "application/json"),
				),
			)
			yield* client.execute(HttpClientRequest.get("https://api.maple.dev/v2/services"))

			strictEqual(yield* Ref.get(asked), 1)
			const [health, query, elsewhere] = sent
			strictEqual(health?.headers.get("cf-access-token"), "cf-jwt")
			strictEqual(health?.headers.get("x-team"), "obs")
			strictEqual(query?.headers.get("cf-access-token"), "cf-jwt")
			strictEqual(query?.headers.get("content-type"), "application/json")
			strictEqual(query?.redirect, "manual")
			strictEqual(elsewhere?.headers.get("cf-access-token"), null)
			strictEqual(elsewhere?.headers.get("x-team"), null)
			strictEqual(elsewhere?.redirect, undefined)
		}),
	)

	it.effect("does not ask cloudflared when a service token is configured", () =>
		Effect.gen(function* () {
			const { sent, layer } = recordingFetch()
			const { asked, settings: s } = yield* settings("https://maple.example.com", {
				"cf-access-client-id": "id.access",
				"cf-access-client-secret": "secret",
			})
			const client = yield* Effect.flatMap(HttpClient.HttpClient, localAccessClient(s)).pipe(
				Effect.provide(layer),
			)

			yield* client.execute(HttpClientRequest.get("https://maple.example.com/local/status"))

			strictEqual(yield* Ref.get(asked), 0)
			strictEqual(sent[0]?.headers.get("cf-access-client-id"), "id.access")
			strictEqual(sent[0]?.headers.get("cf-access-token"), null)
		}),
	)

	it.effect("does not follow a redirect that would carry configured headers to another origin", () =>
		Effect.gen(function* () {
			const { sent, layer } = recordingFetch()
			const { asked, settings: s } = yield* settings("http://maple.lan:4318", {
				"cf-access-client-secret": "secret",
			})
			const client = yield* Effect.flatMap(HttpClient.HttpClient, localAccessClient(s)).pipe(
				Effect.provide(layer),
			)

			yield* client.execute(HttpClientRequest.get("http://maple.lan:4318/local/status"))

			strictEqual(yield* Ref.get(asked), 0)
			strictEqual(sent[0]?.headers.get("cf-access-client-secret"), "secret")
			strictEqual(sent[0]?.redirect, "manual")
		}),
	)

	it.effect("leaves a server on this machine alone: no cloudflared, redirects followed", () =>
		Effect.gen(function* () {
			const { sent, layer } = recordingFetch()
			const { asked, settings: s } = yield* settings("http://127.0.0.1:4318")
			const client = yield* Effect.flatMap(HttpClient.HttpClient, localAccessClient(s)).pipe(
				Effect.provide(layer),
			)

			yield* client.execute(HttpClientRequest.get("http://127.0.0.1:4318/local/status"))

			strictEqual(yield* Ref.get(asked), 0)
			strictEqual(sent[0]?.redirect, undefined)
		}),
	)
})

describe("a refused local query", () => {
	const refusal = (baseUrl: string, response: () => Response) =>
		Effect.gen(function* () {
			const { layer } = recordingFetch(response)
			const mode = Layer.succeed(Mode, { resolve: Effect.succeed({ _tag: "local" as const, baseUrl }) })
			return yield* rawQuery({ sql: "SELECT 1", range: RANGE }).pipe(
				Effect.flip,
				Effect.provide(Layer.merge(mode, layer)),
			)
		})

	it.effect("names cloudflared when an Access proxy redirects to its sign-in page", () =>
		Effect.gen(function* () {
			const error = yield* refusal(
				"https://maple.example.com",
				() =>
					new Response(null, {
						status: 302,
						headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
					}),
			)
			strictEqual(error._tag, "@maple/cli/LocalServerAccessDeniedError")
			strictEqual(
				"hint" in error && error.hint?.includes("cloudflared access login https://maple.example.com"),
				true,
			)
		}),
	)

	it.effect("names the access token when the Maple server itself asks for it", () =>
		Effect.gen(function* () {
			const error = yield* refusal(
				"https://maple.example.com",
				() => new Response("sign in required", { status: 401 }),
			)
			strictEqual(error._tag, "@maple/cli/LocalServerAccessDeniedError")
			strictEqual("hint" in error && error.hint?.includes("MAPLE_LOCAL_ACCESS_TOKEN"), true)
		}),
	)

	it.effect("does not blame a proxy for a 403 from a server on this machine", () =>
		Effect.gen(function* () {
			const error = yield* refusal(
				"http://127.0.0.1:4318",
				() => new Response("browser origin not allowed", { status: 403 }),
			)
			strictEqual(error._tag === "@maple/cli/LocalServerAccessDeniedError", false)
		}),
	)
})
