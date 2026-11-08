import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { readBoundedText } from "./bounded-body"

const encoder = new TextEncoder()

/** A POST whose body arrives in the given chunks, with no declared length. */
const chunked = (chunks: ReadonlyArray<Uint8Array>, headers: Record<string, string> = {}) =>
	HttpServerRequest.fromWeb(
		new Request("http://api.localhost/hook", {
			method: "POST",
			headers,
			body: new ReadableStream<Uint8Array>({
				start: (controller) => {
					for (const chunk of chunks) controller.enqueue(chunk)
					controller.close()
				},
			}),
			duplex: "half",
		}),
	)

describe("readBoundedText", () => {
	it.effect("decodes multi-byte characters split across chunks", () =>
		Effect.gen(function* () {
			const bytes = encoder.encode("héllo €😀")
			const text = yield* readBoundedText(
				chunked([
					bytes.subarray(0, 2),
					bytes.subarray(2, 7),
					bytes.subarray(7, 9),
					bytes.subarray(9),
				]),
				bytes.byteLength,
			)
			assert.strictEqual(text, "héllo €😀")
		}),
	)

	it.effect("refuses a body one byte over the limit, declared or streamed", () =>
		Effect.gen(function* () {
			const body = encoder.encode("0123456789")
			const streamed = yield* readBoundedText(chunked([body.subarray(0, 5), body.subarray(5)]), 9).pipe(
				Effect.flip,
			)
			assert.strictEqual(streamed._tag, "@maple/backend/http/RequestBodyTooLargeError")
			const declared = yield* readBoundedText(chunked([], { "content-length": "10" }), 9).pipe(
				Effect.flip,
			)
			assert.strictEqual(declared._tag, "@maple/backend/http/RequestBodyTooLargeError")
		}),
	)

	it.effect("reads a request without a body as empty", () =>
		Effect.gen(function* () {
			const request = HttpServerRequest.fromWeb(
				new Request("http://api.localhost/hook", { method: "POST" }),
			)
			assert.strictEqual(yield* readBoundedText(request, 10), "")
		}),
	)
})
