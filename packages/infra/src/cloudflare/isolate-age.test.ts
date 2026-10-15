import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { IsolateAge } from "./isolate-age.ts"

/** The attributes one request's server span carries after `record` ran inside it. */
const recordOn = Effect.gen(function* () {
	const { record } = yield* IsolateAge
	yield* record
	const span = yield* Effect.currentSpan
	return {
		ordinal: span.attributes.get("maple.isolate.request_ordinal"),
		ageMs: span.attributes.get("maple.isolate.age_ms"),
	}
}).pipe(Effect.withSpan("http.server POST /mcp"))

describe("IsolateAge", () => {
	it.effect("marks the first request on an isolate and ages later ones from it", () =>
		Effect.gen(function* () {
			yield* TestClock.adjust("5 seconds")
			const first = yield* recordOn
			yield* TestClock.adjust("250 millis")
			const second = yield* recordOn
			yield* TestClock.adjust("1 second")
			const third = yield* recordOn
			assert.deepStrictEqual(first, { ordinal: 1, ageMs: 0 })
			assert.deepStrictEqual(second, { ordinal: 2, ageMs: 250 })
			assert.deepStrictEqual(third, { ordinal: 3, ageMs: 1250 })
		}).pipe(Effect.provide(IsolateAge.layer)),
	)

	it.effect("gives concurrent requests distinct ordinals", () =>
		Effect.gen(function* () {
			const stamps = yield* Effect.all(
				Array.from({ length: 50 }, () => recordOn),
				{ concurrency: "unbounded" },
			)
			const ordinals = stamps.map((stamp) => Number(stamp.ordinal)).sort((a, b) => a - b)
			assert.deepStrictEqual(
				ordinals,
				Array.from({ length: 50 }, (_, index) => index + 1),
			)
		}).pipe(Effect.provide(IsolateAge.layer)),
	)

	it.effect("counts per isolate: a fresh layer starts at ordinal 1", () =>
		Effect.gen(function* () {
			yield* recordOn.pipe(Effect.provide(IsolateAge.layer))
			yield* TestClock.adjust("1 second")
			const fresh = yield* recordOn.pipe(Effect.provide(IsolateAge.layer))
			assert.deepStrictEqual(fresh, { ordinal: 1, ageMs: 0 })
		}),
	)
})
