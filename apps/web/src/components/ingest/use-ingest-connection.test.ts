import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { Cause } from "effect"
import { readIngestKeys, sendTestEventEffect } from "./use-ingest-connection"

interface RecordedRequest {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly body: unknown
}

const runWithResponse = (recorded: Array<RecordedRequest>, response: Response) => {
	const fetchStub: typeof globalThis.fetch = async (input, init) => {
		const body =
			typeof init?.body === "string"
				? JSON.parse(init.body)
				: init?.body instanceof Uint8Array
					? JSON.parse(new TextDecoder().decode(init.body))
					: undefined
		recorded.push({
			url: input instanceof Request ? input.url : String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body,
		})
		return response
	}

	return sendTestEventEffect("maple_pk_test").pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fetchStub),
	)
}

describe("sendTestEventEffect", () => {
	it.effect("posts a deterministic synthetic trace using the Effect clock", () =>
		Effect.gen(function* () {
			const now = Date.UTC(2026, 7, 11, 12, 0, 0)
			yield* TestClock.setTime(now)
			const recorded: Array<RecordedRequest> = []

			yield* runWithResponse(recorded, new Response(null, { status: 202 }))

			assert.lengthOf(recorded, 1)
			assert.strictEqual(recorded[0]?.url, "https://ingest.maple.dev/v1/traces")
			assert.strictEqual(recorded[0]?.method, "POST")
			assert.strictEqual(recorded[0]?.headers.get("authorization"), "Bearer maple_pk_test")
			const payload = recorded[0]?.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{ startTimeUnixNano: string; endTimeUnixNano: string }>
					}>
				}>
			}
			const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
			assert.strictEqual(span.startTimeUnixNano, `${now - 87}000000`)
			assert.strictEqual(span.endTimeUnixNano, `${now}000000`)
		}),
	)

	it.effect("fails with a schema-backed rejection on a non-2xx response", () =>
		Effect.gen(function* () {
			const error = yield* runWithResponse([], new Response(null, { status: 401 })).pipe(Effect.flip)
			if (error._tag !== "@maple/web/TestEventIngestRejected") {
				return assert.fail(`Expected tagged ingest rejection, got ${error._tag}`)
			}
			assert.strictEqual(error.status, 401)
		}),
	)
})

describe("readIngestKeys", () => {
	const keys = {
		object: "ingest_keys" as const,
		public_key: "maple_pk_public",
		private_key: "maple_sk_private",
		public_rotated_at: "2026-10-01T00:00:00.000Z",
		private_rotated_at: "2026-10-01T00:00:00.000Z",
	}

	it("hands the server snippets the private key and the browser test event the public one", () => {
		assert.deepStrictEqual(readIngestKeys(AsyncResult.success(keys)), {
			publicKey: "maple_pk_public",
			privateKey: "maple_sk_private",
			status: "ready",
		})
	})

	it("exposes neither key when the admin-only read is denied", () => {
		assert.deepStrictEqual(readIngestKeys(AsyncResult.failure(Cause.fail("forbidden"))), {
			publicKey: "",
			privateKey: "",
			status: "failed",
		})
	})

	it("reports loading before the read settles", () => {
		assert.strictEqual(readIngestKeys(AsyncResult.initial(true)).status, "loading")
	})
})
