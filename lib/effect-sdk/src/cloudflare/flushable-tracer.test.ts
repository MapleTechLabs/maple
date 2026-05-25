import { assert, describe, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { makeSpanBuffer } from "./flushable-tracer.js"

// A benign error flagged exactly the way Effect's RouteNotFound is.
class BenignError extends Data.TaggedError("BenignError")<{}> {
	readonly [ErrorReporter.ignore] = true
}
// A real reportable failure (no ignore flag) — e.g. a 400/500.
class ReportableError extends Data.TaggedError("ReportableError")<{}> {}

const runSpan = (buffer: ReturnType<typeof makeSpanBuffer>, effect: Effect.Effect<unknown, unknown>) =>
	Effect.runPromise(effect.pipe(Effect.withSpan("http.server GET"), Effect.provide(buffer.tracerLayer), Effect.exit))

describe("makeSpanBuffer ignored-failure drop", () => {
	it("drops spans whose failure carries [ErrorReporter.ignore]", async () => {
		const buffer = makeSpanBuffer()
		await runSpan(buffer, Effect.fail(new BenignError()))
		assert.strictEqual(buffer.size(), 0)
	})

	it("keeps spans that fail with a reportable error", async () => {
		const buffer = makeSpanBuffer()
		await runSpan(buffer, Effect.fail(new ReportableError()))
		assert.strictEqual(buffer.size(), 1)
	})

	it("keeps successful spans", async () => {
		const buffer = makeSpanBuffer()
		await runSpan(buffer, Effect.succeed(undefined))
		assert.strictEqual(buffer.size(), 1)
	})

	// Pins the upstream contract: the actual error HttpRouter raises for an
	// unmatched route must stay [ErrorReporter.ignore]-flagged, so the drop holds.
	it("drops the real HttpServerError/RouteNotFound", async () => {
		const buffer = makeSpanBuffer()
		const request = HttpServerRequest.fromWeb(new Request("http://localhost/nope"))
		const error = new HttpServerError.HttpServerError({ reason: new HttpServerError.RouteNotFound({ request }) })
		await runSpan(buffer, Effect.fail(error))
		assert.strictEqual(buffer.size(), 0)
	})
})
