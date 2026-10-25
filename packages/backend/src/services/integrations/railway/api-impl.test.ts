import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { discover } from "./api-impl"

const graphql = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/** Answers each request with the next body; the last one repeats. */
const stubClient = (bodies: ReadonlyArray<unknown>) => {
	const seen: Array<string> = []
	const client = HttpClient.make((request) => {
		const body = bodies[Math.min(seen.length, bodies.length - 1)]
		seen.push(request.url)
		return Effect.succeed(HttpClientResponse.fromWeb(request, graphql(body)))
	})
	return { seen, client }
}

const PROBLEM = { data: null, errors: [{ message: "Problem processing request" }] }

describe("Railway API access", () => {
	it.effect("retries Railway's transient 'Problem processing request' before failing", () =>
		Effect.gen(function* () {
			const http = stubClient([PROBLEM])
			const fiber = yield* Effect.forkChild(Effect.flip(discover(http.client, "token")))
			yield* TestClock.adjust("10 seconds")
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error.kind, "upstream")
			assert.lengthOf(http.seen, 3)
		}),
	)

	it.effect("does not retry a rejected token", () =>
		Effect.gen(function* () {
			const http = stubClient([{ data: null, errors: [{ message: "Not Authorized" }] }])
			const error = yield* Effect.flip(discover(http.client, "token"))
			assert.strictEqual(error.kind, "unauthorized")
			assert.lengthOf(http.seen, 1)
		}),
	)
})
