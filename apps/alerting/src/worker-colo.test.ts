import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { ColoLookupError, isolateColoCache, lookupColo, TRACE_URL } from "./worker-colo"

const TRACE_BODY =
	"fl=29f1\nh=cloudflare.com\nip=2a06:98c0::1\nts=1760000000.1\nvisit_scheme=https\ncolo=IAD\nhttp=http/1.1\nloc=US\n"

/** An HttpClient that answers every request with `body`, recording the URLs it was sent. */
const answering = (body: string, status = 200) => {
	const urls: Array<string> = []
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			urls.push(request.url)
			return HttpClientResponse.fromWeb(request, new Response(body, { status }))
		}),
	)
	return { client, urls }
}

describe("lookupColo", () => {
	it.effect("reads the data center from the trace endpoint", () =>
		Effect.gen(function* () {
			const { client, urls } = answering(TRACE_BODY)
			const colo = yield* lookupColo().pipe(Effect.provideService(HttpClient.HttpClient, client))
			expect(colo).toBe("IAD")
			expect(urls).toEqual([TRACE_URL])
		}),
	)

	it.effect("fails when the answer carries no colo, such as an error page", () =>
		Effect.gen(function* () {
			const { client } = answering("<html>blocked</html>", 403)
			const error = yield* lookupColo().pipe(
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.flip,
			)
			expect(error._tag).toBe("@maple/alerting/errors/ColoLookupError")
		}),
	)
})

describe("isolateColoCache", () => {
	it.effect(
		"a caller never waits on another caller's lookup, and a known colo is not looked up again",
		() =>
			Effect.gen(function* () {
				let calls = 0
				// The first lookup never settles, like one whose request the runtime has moved on from.
				const lookup = Effect.suspend(() => {
					calls++
					return calls === 1 ? Effect.never : Effect.succeed("IAD")
				})
				const colo = yield* isolateColoCache(lookup)
				const stalled = yield* Effect.forkChild(colo)
				yield* Effect.yieldNow
				expect(yield* colo).toBe("IAD")
				expect(yield* colo).toBe("IAD")
				expect(calls).toBe(2)
				yield* Fiber.interrupt(stalled)
			}),
	)

	it.effect("a failed lookup reads as unknown and is not retried", () =>
		Effect.gen(function* () {
			let calls = 0
			const colo = yield* isolateColoCache(
				Effect.suspend(() => {
					calls++
					return Effect.fail(new ColoLookupError({ message: "Trace request timed out" }))
				}),
			)
			expect(yield* colo).toBe("unknown")
			expect(yield* colo).toBe("unknown")
			expect(calls).toBe(1)
		}),
	)
})
