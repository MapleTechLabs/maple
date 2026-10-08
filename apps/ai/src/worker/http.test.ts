import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { makeIsolateAgeRecorder } from "./http"

/** The attributes one request's server span carries after the recorder ran inside it. */
const recordOn = (record: Effect.Effect<void>) =>
	Effect.gen(function* () {
		yield* record
		const span = yield* Effect.currentSpan
		return {
			ordinal: span.attributes.get("maple.isolate.request_ordinal"),
			ageMs: span.attributes.get("maple.isolate.age_ms"),
		}
	}).pipe(Effect.withSpan("http.server POST /mcp"))

describe("makeIsolateAgeRecorder", () => {
	it.effect("marks the first request on an isolate and ages later ones from it", () =>
		Effect.gen(function* () {
			const record = makeIsolateAgeRecorder()
			const first = yield* recordOn(record)
			yield* TestClock.adjust("250 millis")
			const second = yield* recordOn(record)
			assert.deepStrictEqual(first, { ordinal: 1, ageMs: 0 })
			assert.deepStrictEqual(second, { ordinal: 2, ageMs: 250 })
		}),
	)

	it.effect("counts per isolate, not per module", () =>
		Effect.gen(function* () {
			yield* recordOn(makeIsolateAgeRecorder())
			const fresh = yield* recordOn(makeIsolateAgeRecorder())
			assert.deepStrictEqual(fresh, { ordinal: 1, ageMs: 0 })
		}),
	)
})
