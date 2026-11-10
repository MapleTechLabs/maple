import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { makeMemoryBackend } from "./cache-backend"

const HOUR_MS = 3_600_000

describe("makeMemoryBackend", () => {
	it.effect("drops expired entries whose keys are never read again", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			yield* backend.put("pinned", "live", "kept", 100_000 * 3600, 0)
			// One key per hour with a one-hour TTL: each is expired before the next is written.
			yield* Effect.forEach(Arr.range(1, 5000), (hour) =>
				backend.put("baseline", `org_1:${hour}`, hour, 3600, hour * HOUR_MS * 2),
			)

			assert.isBelow(backend.size(), 1000)
			assert.strictEqual(yield* backend.get("pinned", "live", 5000 * HOUR_MS * 2), "kept")
		}),
	)

	it.effect("keeps every entry that has not expired", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const keys = Arr.range(1, 2000)
			yield* Effect.forEach(keys, (n) => backend.put("bucket", `k${n}`, n, 3600, n))
			const values = yield* Effect.forEach(keys, (n) => backend.get("bucket", `k${n}`, 5000))

			assert.deepStrictEqual(values, keys)
		}),
	)

	it.effect("does not store an entry whose TTL is not a finite number", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			yield* backend.put("bucket", "key", "old", 60, 0)
			yield* backend.put("bucket", "key", "nan", Number.NaN, 0)
			yield* backend.put("bucket", "other", "forever", Number.POSITIVE_INFINITY, 0)

			assert.isUndefined(yield* backend.get("bucket", "key", 1))
			assert.isUndefined(yield* backend.get("bucket", "other", 1))
			assert.strictEqual(backend.size(), 0)
		}),
	)
})
