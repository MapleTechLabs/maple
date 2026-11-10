import { Array as Arr, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { GC_MS, hashKey } from "./cache-store"
import { type CacheState, collectUnused, LocalQueryCache } from "./query-cache"

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

describe("collectUnused", () => {
	const initial: CacheState = { entries: new Map(), lastUsed: new Map() }

	/** A tab left open on a relative range: every minute is a new key, used once. */
	const afterMinutes = (minutes: number): CacheState =>
		Arr.reduce(
			Arr.makeBy(minutes, (minute) => minute),
			initial,
			(state, minute) => {
				const nowMs = minute * 60_000
				const key = ["local", "logs", `window-${minute}`]
				return collectUnused(
					{
						entries: new Map([
							...state.entries,
							[hashKey(key), { key, data: minute, updatedAtMs: nowMs }],
						]),
						lastUsed: new Map(state.lastUsed).set(hashKey(key), nowMs),
					},
					nowMs,
				)
			},
		)

	test("use times are kept only for the results still cached", () => {
		const state = afterMinutes(300)

		expect(state.entries.size).toBe(GC_MS / 60_000)
		expect([...state.lastUsed.keys()]).toEqual([...state.entries.keys()])
	})

	test("a result used within the hour keeps its use time", () => {
		const key = ["local", "trace", "t1"]
		const state: CacheState = {
			entries: new Map([[hashKey(key), { key, data: 1, updatedAtMs: 0 }]]),
			lastUsed: new Map([[hashKey(key), 1_000]]),
		}

		expect(collectUnused(state, GC_MS).lastUsed.get(hashKey(key))).toBe(1_000)
	})
})
