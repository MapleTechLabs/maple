import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { TestClock } from "effect/testing"
import { batchesBefore } from "./aws-security-readers"

describe("batchesBefore", () => {
	it.effect("starts no batch past the deadline and keeps what the earlier ones found", () =>
		Effect.gen(function* () {
			const ids = Arr.makeBy(30, (index) => `f-${index}`)
			// Each batch takes ten seconds and finds its first id only.
			const read = yield* batchesBefore(ids, 10, 15_000, (chunk) =>
				Effect.as(TestClock.adjust("10 seconds"), Arr.take(chunk, 1)),
			)
			assert.deepStrictEqual(read.found, ["f-0", "f-10"])
			// The third batch never ran, so its ids are neither found nor missing.
			assert.deepStrictEqual(read.queried, Arr.take(ids, 20))
		}),
	)
})
