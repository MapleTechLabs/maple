import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { forwardsToAi, forwardToAi, isCloudflareFetcher } from "./ai-forward"

/**
 * The predicate IS the contract between the two Workers: a path it misses 404s
 * from api's own router, and one it over-matches never reaches api's routes at
 * all. Both failures are silent in a typecheck, hence the table.
 */
describe("forwardsToAi", () => {
	it("forwards the MCP transport and the chat surfaces", () => {
		for (const path of [
			"/mcp",
			"/mcp/",
			"/mcp/anything",
			"/api/chat/sessions/org:tab/history",
			"/api/chat/sessions/org:tab/events",
			"/api/chat/sessions/org:tab/messages",
			"/api/chat/sessions/org:tab/abort",
			"/internal/chat/apply",
		]) {
			assert.isTrue(forwardsToAi(path), path)
		}
	})

	it("keeps every other path on api, including neighbours of the forwarded ones", () => {
		for (const path of [
			"/",
			"/health",
			"/mcp-something",
			"/mcpx",
			"/.well-known/oauth-protected-resource/mcp",
			"/oauth/authorize",
			"/api/chatter",
			"/api/chat",
			"/internal/chatty",
			"/internal/ai-sessions",
			"/v2/errors",
		]) {
			assert.isFalse(forwardsToAi(path), path)
		}
	})
})

describe("isCloudflareFetcher", () => {
	it("accepts a binding exposing fetch and rejects everything else", () => {
		assert.isTrue(isCloudflareFetcher({ fetch: () => new Response("ok") }))
		for (const value of [undefined, null, {}, "AI_WORKER", { fetch: "nope" }]) {
			assert.isFalse(isCloudflareFetcher(value), JSON.stringify(value))
		}
	})
})

/**
 * SAFETY: the forward calls `fetch` and nothing else, so the stub implements
 * that and is asserted to the binding's type rather than growing a `connect`
 * this path never reaches.
 */
const echoFetcher = (seen: Array<Request>) =>
	({
		fetch: (input: RequestInfo | URL) => {
			if (input instanceof Request) seen.push(input)
			return Promise.resolve(new Response("forwarded", { status: 207 }))
		},
	}) as Fetcher

describe("forwardToAi", () => {
	it.effect("hands maple-ai this hop's span as traceparent, and keeps the rest of the request", () =>
		Effect.gen(function* () {
			const seen: Array<Request> = []
			const request = HttpServerRequest.fromWeb(
				new Request("https://api.maple.dev/mcp", {
					method: "POST",
					headers: { authorization: "Bearer key", "content-type": "application/json" },
					body: '{"method":"tools/list"}',
				}),
			)

			const response = yield* forwardToAi(echoFetcher(seen), request)
			const span = yield* Effect.currentSpan

			assert.strictEqual(response.status, 207)
			const forwarded = seen[0]
			assert.isDefined(forwarded)
			assert.strictEqual(forwarded.method, "POST")
			assert.strictEqual(forwarded.headers.get("authorization"), "Bearer key")
			assert.strictEqual(new URL(forwarded.url).host, "api.maple.dev")
			// Parented to api's own server span, so the two Workers share one trace
			// and the service map gains the edge between them.
			assert.strictEqual(forwarded.headers.get("traceparent"), `00-${span.traceId}-${span.spanId}-01`)
			assert.strictEqual(yield* Effect.promise(() => forwarded.text()), '{"method":"tools/list"}')
		}).pipe(Effect.withSpan("test-root")),
	)

	it.effect("forwards unchanged when nothing is tracing", () =>
		Effect.gen(function* () {
			const seen: Array<Request> = []
			const request = HttpServerRequest.fromWeb(new Request("https://api.maple.dev/mcp"))

			yield* forwardToAi(echoFetcher(seen), request)

			assert.isNull(seen[0]?.headers.get("traceparent") ?? null)
		}),
	)
})
