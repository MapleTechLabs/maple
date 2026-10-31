import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { readTextPrefix, readTextWithin, ResponseTooLargeError } from "./index"

const encoder = new TextEncoder()

/** A body served in `chunks`, counting how many chunks the reader pulled. */
const chunked = (chunks: ReadonlyArray<string>, headers?: Record<string, string>) => {
	const pulled = { count: 0 }
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const next = chunks[pulled.count]
				pulled.count++
				if (next === undefined) controller.close()
				else controller.enqueue(encoder.encode(next))
			},
		},
		{ highWaterMark: 0 },
	)
	const response = HttpClientResponse.fromWeb(
		HttpClientRequest.get("https://api.example.com/x"),
		new Response(body, { headers }),
	)
	return { response, pulled }
}

/** A body that never ends: reading it unbounded never returns. */
const endless = () => {
	const pulled = { count: 0 }
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled.count++
			controller.enqueue(encoder.encode("x".repeat(1024)))
		},
	})
	const response = HttpClientResponse.fromWeb(
		HttpClientRequest.get("https://api.example.com/x"),
		new Response(body),
	)
	return { response, pulled }
}

describe("readTextPrefix", () => {
	it.effect("reads a body under the limit in full", () =>
		Effect.gen(function* () {
			const { response } = chunked(["hello ", "wörld"])
			const result = yield* readTextPrefix(response, 1024)
			assert.deepStrictEqual(result, { text: "hello wörld", truncated: false })
		}),
	)

	it.effect("stops at the limit on an endless chunked body", () =>
		Effect.gen(function* () {
			const { response, pulled } = endless()
			const result = yield* readTextPrefix(response, 4096 + 10)
			assert.strictEqual(result.text.length, 4096 + 10)
			assert.isTrue(result.truncated)
			assert.isAtMost(pulled.count, 8)
		}),
	)
})

describe("readTextWithin", () => {
	it.effect("reads a body of exactly the limit", () =>
		Effect.gen(function* () {
			const { response } = chunked(["abcd", "efgh"])
			assert.strictEqual(yield* readTextWithin(response, 8), "abcdefgh")
		}),
	)

	it.effect("fails once an endless body passes the limit", () =>
		Effect.gen(function* () {
			const { response, pulled } = endless()
			const error = yield* Effect.flip(readTextWithin(response, 64 * 1024))
			assert.instanceOf(error, ResponseTooLargeError)
			assert.isAtMost(pulled.count, 70)
		}),
	)

	it.effect("fails on a declared Content-Length over the limit without reading", () =>
		Effect.gen(function* () {
			const { response, pulled } = chunked(["abc"], { "content-length": "999999" })
			const error = yield* Effect.flip(readTextWithin(response, 1024))
			assert.instanceOf(error, ResponseTooLargeError)
			assert.strictEqual(pulled.count, 0)
		}),
	)
})
