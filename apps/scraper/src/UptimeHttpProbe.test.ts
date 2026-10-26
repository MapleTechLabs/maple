import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { UPTIME_USER_AGENT, UptimeHttpConfig } from "@maple/domain/uptime"
import { HostResolver } from "@maple/safe-fetch/dns"
import { hang, type RecordedRequest, stubFetch } from "./testing/stub-fetch"
import { fixedResolver, httpConfig } from "./testing/uptime"
import { UptimeHttpProbe } from "./UptimeHttpProbe"

const DNS = new Map([
	["api.example.com", ["93.184.216.34"]],
	["moved.example.org", ["93.184.216.35"]],
	["rebind.example.com", ["93.184.216.36", "10.0.0.7"]],
])

const ProbeLive = UptimeHttpProbe.layer.pipe(
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(Layer.succeed(HostResolver, fixedResolver(DNS))),
)

const decodeConfig = Schema.decodeUnknownSync(UptimeHttpConfig)
const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }

const probeWith = (
	recorded: Array<RecordedRequest>,
	respond: Parameters<typeof stubFetch>[1],
	overrides: Record<string, unknown> = {},
) =>
	Effect.gen(function* () {
		const probe = yield* UptimeHttpProbe
		return yield* probe.probe(decodeConfig(httpConfig(overrides)), TRACE)
	}).pipe(Effect.provideService(FetchHttpClient.Fetch, stubFetch(recorded, respond)))

describe("UptimeHttpProbe", () => {
	it.effect("a 200 is up, sent at the pinned address with traceparent and user-agent", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const outcome = yield* probeWith(recorded, () => new Response("ok", { status: 200 }), {
				headers: { "X-Probe": "1" },
			})

			assert.deepStrictEqual(
				{ ok: outcome.ok, statusCode: outcome.statusCode, error: outcome.error },
				{ ok: true, statusCode: 200, error: null },
			)
			const [request] = recorded
			assert.strictEqual(request?.url, "https://93.184.216.34/checkout/health")
			assert.strictEqual(request?.headers.host, "api.example.com")
			assert.strictEqual(request?.headers.traceparent, `00-${TRACE.traceId}-${TRACE.spanId}-01`)
			assert.strictEqual(request?.headers["user-agent"], UPTIME_USER_AGENT)
			assert.strictEqual(request?.headers["x-probe"], "1")
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("a 503 is a failed result with the assertion's sentence, not a transport error", () =>
		Effect.gen(function* () {
			const outcome = yield* probeWith([], () => new Response("down", { status: 503 }))
			assert.deepStrictEqual(
				{
					ok: outcome.ok,
					statusCode: outcome.statusCode,
					error: outcome.error,
					type: outcome.errorType,
				},
				{ ok: false, statusCode: 503, error: "Status 503, expected 2xx", type: "assertion" },
			)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("a configured status rule replaces the implicit 2xx", () =>
		Effect.gen(function* () {
			const outcome = yield* probeWith([], () => new Response("", { status: 401 }), {
				assertions: [{ _tag: "status", op: "is", value: "401" }],
			})
			assert.isTrue(outcome.ok)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("judges body and header assertions on the response", () =>
		Effect.gen(function* () {
			const respond = () =>
				new Response('{"status":"degraded"}', { status: 200, headers: { "X-Region": "fra" } })
			const body = yield* probeWith([], respond, {
				assertions: [{ _tag: "json_path", path: "status", op: "equals", value: "ok" }],
			})
			assert.strictEqual(body.error, "JSON path status is degraded, expected ok")
			const header = yield* probeWith([], respond, {
				assertions: [{ _tag: "header", name: "X-Region", op: "equals", value: "fra" }],
			})
			assert.isTrue(header.ok)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("POSTs the configured body; HEAD reads no body", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			yield* probeWith(recorded, () => new Response("", { status: 204 }), {
				method: "POST",
				body: '{"ping":true}',
				headers: { "content-type": "application/json" },
			})
			assert.strictEqual(recorded[0]?.method, "POST")
			assert.strictEqual(recorded[0]?.body, '{"ping":true}')
			assert.strictEqual(recorded[0]?.headers["content-type"], "application/json")

			const head = yield* probeWith([], () => new Response(null, { status: 200 }), {
				method: "HEAD",
				assertions: [{ _tag: "body", op: "contains", value: "x" }],
			})
			assert.strictEqual(head.error, 'Body does not contain "x"')
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("times out after the configured timeout with one sentence", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				probeWith([], (_, signal) => hang(signal), { timeoutMs: 10_000 }),
			)
			yield* TestClock.adjust(Duration.seconds(10))
			const outcome = yield* Fiber.join(fiber)
			assert.deepStrictEqual(
				{ ok: outcome.ok, error: outcome.error, type: outcome.errorType },
				{ ok: false, error: "Connection timed out after 10 s", type: "timeout" },
			)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("re-validates each redirect hop and refuses one that resolves privately", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const outcome = yield* probeWith(recorded, () =>
				recorded.length === 1
					? new Response(null, {
							status: 302,
							headers: { location: "https://rebind.example.com/" },
						})
					: new Response("internal", { status: 200 }),
			)
			assert.strictEqual(outcome.errorType, "ssrf_refused")
			assert.isFalse(outcome.ok)
			assert.include(outcome.error ?? "", "rebind.example.com")
			// The private hop was never dialled.
			assert.lengthOf(recorded, 1)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("follows a redirect to a public host", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const outcome = yield* probeWith(recorded, () =>
				recorded.length === 1
					? new Response(null, {
							status: 301,
							headers: { location: "https://moved.example.org/h" },
						})
					: new Response("ok", { status: 200 }),
			)
			assert.isTrue(outcome.ok)
			assert.strictEqual(recorded[1]?.url, "https://93.184.216.35/h")
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("sends no configured header or body across origins on a redirect", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const outcome = yield* probeWith(
				recorded,
				() =>
					recorded.length === 1
						? new Response(null, {
								status: 302,
								headers: { location: "https://moved.example.org/h" },
							})
						: new Response("ok", { status: 200 }),
				{
					method: "POST",
					body: '{"secret":true}',
					headers: { Authorization: "Bearer probe-secret", "X-Api-Key": "key-secret" },
				},
			)
			assert.isTrue(outcome.ok)
			const hop = recorded[1]
			assert.strictEqual(hop?.url, "https://93.184.216.35/h")
			assert.strictEqual(hop?.method, "GET")
			assert.isNull(hop?.body ?? null)
			assert.isUndefined(hop?.headers.authorization)
			assert.isUndefined(hop?.headers["x-api-key"])
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("keeps method, body and headers on a same-origin 307", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			yield* probeWith(
				recorded,
				() =>
					recorded.length === 1
						? new Response(null, { status: 307, headers: { location: "/v2/health" } })
						: new Response("ok", { status: 200 }),
				{ method: "POST", body: "ping", headers: { "X-Api-Key": "key-secret" } },
			)
			const hop = recorded[1]
			assert.strictEqual(hop?.method, "POST")
			assert.strictEqual(hop?.body, "ping")
			assert.strictEqual(hop?.headers["x-api-key"], "key-secret")
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("names the host it could not resolve, and refuses a private literal without a request", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const missing = yield* probeWith(recorded, () => new Response("", { status: 200 }), {
				url: "https://gone.example.net/",
			})
			assert.deepStrictEqual(
				{ error: missing.error, type: missing.errorType },
				{ error: "Couldn't resolve gone.example.net", type: "dns" },
			)
			const local = yield* probeWith(recorded, () => new Response("", { status: 200 }), {
				url: "http://127.0.0.1:8080/",
			})
			assert.strictEqual(local.errorType, "ssrf_refused")
			assert.lengthOf(recorded, 0)
		}).pipe(Effect.provide(ProbeLive)),
	)

	it.effect("reports a refused connection as a sentence about the endpoint", () =>
		Effect.gen(function* () {
			const refused = Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			})
			const outcome = yield* probeWith([], () => Promise.reject(refused))
			assert.deepStrictEqual(
				{ error: outcome.error, type: outcome.errorType },
				{ error: "Connection refused by api.example.com:443", type: "connection_refused" },
			)
		}).pipe(Effect.provide(ProbeLive)),
	)
})
