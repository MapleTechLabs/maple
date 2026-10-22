import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { LocalQueryCache } from "./query-cache"

// The cache as the runtime builds it, on a test clock: `gcTime` drops what nothing used for an hour.

const KEY = ["local", "trace", "t1"]
const OTHER = ["local", "trace", "t2"]

beforeEach(() => {
	vi.stubGlobal("window", { location: new URL("http://127.0.0.1:4318/") })
	vi.stubGlobal("document", {
		visibilityState: "visible",
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	})
})
afterEach(() => vi.unstubAllGlobals())

const run = <A>(program: Effect.Effect<A, never, LocalQueryCache>) =>
	Effect.runPromise(
		program.pipe(
			Effect.provide(LocalQueryCache.layer.pipe(Layer.provideMerge(TestClock.layer()))),
			Effect.scoped,
		),
	)

const isCached = (key: ReadonlyArray<unknown>) =>
	Effect.gen(function* () {
		return Option.isSome(yield* (yield* LocalQueryCache).lookup(key))
	})

describe("LocalQueryCache gcTime", () => {
	test("a result nothing reads or writes for an hour is dropped", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const cache = yield* LocalQueryCache
				yield* cache.record(KEY, { rows: [1] }, 0)
				yield* cache.record(OTHER, { rows: [2] }, 0)
				yield* TestClock.adjust("59 minutes")
				const kept = yield* isCached(KEY)
				yield* TestClock.adjust("59 minutes")
				// KEY was read 59 minutes ago; OTHER has been idle for 118.
				return { kept, stillKept: yield* isCached(KEY), other: yield* isCached(OTHER) }
			}),
		)
		expect(seen).toEqual({ kept: true, stillKept: true, other: false })
	})

	test("a read keeps the result an hour from then, and an idle hour after it drops it", async () => {
		const gone = await run(
			Effect.gen(function* () {
				const cache = yield* LocalQueryCache
				yield* cache.record(KEY, { rows: [1] }, 0)
				yield* TestClock.adjust("30 minutes")
				yield* isCached(KEY)
				yield* TestClock.adjust("61 minutes")
				return !(yield* isCached(KEY))
			}),
		)
		expect(gone).toBe(true)
	})
})
