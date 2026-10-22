import { Deferred, Effect, Exit, Fiber, Ref, Schema, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { READ_CACHE_MAX_ENTRIES, ReadCache } from "./read-cache"
import { requestKey } from "./request-key"

const TTL_MS = 30_000
const Count = Schema.Struct({ count: Schema.Number })

const keyOf = (org: string, sha = "a") => requestKey(org, "vcsCommitDetail", { sha })

/** A load that counts its runs and answers with the run number. */
const counting = Effect.map(Ref.make(0), (runs) => ({
	runs,
	load: Effect.map(
		Ref.updateAndGet(runs, (n) => n + 1),
		(count) => ({ count }),
	),
}))

const run = <A, E>(effect: Effect.Effect<A, E, ReadCache | Scope.Scope>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(ReadCache.layer), Effect.scoped, Effect.provide(TestClock.layer())),
	)

const read = (key: string, load: Effect.Effect<{ count: number }, unknown>, refresh = false) =>
	Effect.flatMap(Effect.service(ReadCache), (cache) =>
		cache.read({ key, idleTtlMs: TTL_MS, schema: Count, refresh }, load),
	)

describe("ReadCache", () => {
	test("a second reader of a settled key is answered from the cache", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 1 })
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 1 })
				expect(yield* Ref.get(runs)).toBe(1)
			}),
		))

	test("readers of an in-flight key share its one request", () =>
		run(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>()
				const { runs, load } = yield* counting
				const held = Effect.andThen(Deferred.await(gate), load)
				const first = yield* Effect.forkChild(read(keyOf("org_a"), held))
				const second = yield* Effect.forkChild(read(keyOf("org_a"), held))
				yield* Effect.yieldNow
				yield* Deferred.succeed(gate, undefined)
				expect(yield* Fiber.join(first)).toEqual({ count: 1 })
				expect(yield* Fiber.join(second)).toEqual({ count: 1 })
				expect(yield* Ref.get(runs)).toBe(1)
			}),
		))

	test("an entry idle past its TTL is read again", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				yield* read(keyOf("org_a"), load)
				yield* TestClock.adjust(TTL_MS + 1)
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 2 })
				expect(yield* Ref.get(runs)).toBe(2)
			}),
		))

	test("a release restarts the idle TTL, as a page leaving unmounts its atoms", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				yield* read(keyOf("org_a"), load)
				yield* TestClock.adjust(TTL_MS - 1)
				yield* Effect.flatMap(Effect.service(ReadCache), (cache) => cache.release([keyOf("org_a")]))
				yield* TestClock.adjust(TTL_MS - 1)
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 1 })
				expect(yield* Ref.get(runs)).toBe(1)
			}),
		))

	test("an org switch drops the other org's entries", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				yield* read(keyOf("org_a"), load)
				yield* read(keyOf("org_b"), load)
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 3 })
				expect(yield* Ref.get(runs)).toBe(3)
			}),
		))

	test("a reader naming its org is not answered from the open org's entry", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				const cache = yield* Effect.service(ReadCache)
				const spec = { operation: "getServicesFacets", input: {}, idleTtlMs: TTL_MS, schema: Count }
				yield* cache.scopeTo("org_a")
				yield* cache.readInOrg(spec, load)
				// The org switched; the root has not scoped the cache to the new org yet.
				expect(yield* cache.readInOrg({ ...spec, orgId: "org_b" }, load)).toEqual({ count: 2 })
				expect(yield* Ref.get(runs)).toBe(2)
			}),
		))

	test("past the bound, the least recently read entry goes, not the oldest inserted", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				const shas = Array.from({ length: READ_CACHE_MAX_ENTRIES }, (_, index) => `sha${index}`)
				yield* Effect.forEach(shas, (sha) => read(keyOf("org_a", sha), load), { discard: true })
				// Reading the first entry again makes the second the least recently read.
				yield* read(keyOf("org_a", "sha0"), load)
				yield* read(keyOf("org_a", "new"), load)
				const before = yield* Ref.get(runs)
				yield* read(keyOf("org_a", "sha0"), load)
				expect(yield* Ref.get(runs)).toBe(before)
				yield* read(keyOf("org_a", "sha1"), load)
				expect(yield* Ref.get(runs)).toBe(before + 1)
			}),
		))

	test("past the bound, idle-expired entries go before recently read ones", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				const cache = yield* Effect.service(ReadCache)
				const shas = Array.from({ length: READ_CACHE_MAX_ENTRIES - 1 }, (_, index) => `sha${index}`)
				yield* Effect.forEach(shas, (sha) => read(keyOf("org_a", sha), load), { discard: true })
				// The most recently read entry, but idle past its own short TTL.
				yield* cache.read({ key: keyOf("org_a", "expired"), idleTtlMs: 1_000, schema: Count }, load)
				yield* TestClock.adjust(1_001)
				yield* read(keyOf("org_a", "new"), load)
				const before = yield* Ref.get(runs)
				// `sha0` is the least recently read, yet it stays: the expired entry went instead.
				yield* read(keyOf("org_a", "sha0"), load)
				expect(yield* Ref.get(runs)).toBe(before)
			}),
		))

	test("past the bound, only the excess goes: an expired entry still held is revived on release", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				const cache = yield* Effect.service(ReadCache)
				const short = (sha: string) =>
					cache.read({ key: keyOf("org_a", sha), idleTtlMs: 1_000, schema: Count }, load)
				yield* short("first")
				yield* short("second")
				const shas = Array.from({ length: READ_CACHE_MAX_ENTRIES - 2 }, (_, index) => `sha${index}`)
				yield* Effect.forEach(shas, (sha) => read(keyOf("org_a", sha), load), { discard: true })
				yield* TestClock.adjust(1_001)
				yield* read(keyOf("org_a", "new"), load)
				// The page holding `second` leaves: its idle TTL starts again.
				yield* cache.release([keyOf("org_a", "second")])
				const before = yield* Ref.get(runs)
				yield* short("second")
				expect(yield* Ref.get(runs)).toBe(before)
				yield* short("first")
				expect(yield* Ref.get(runs)).toBe(before + 1)
			}),
		))

	test("a read counts as recent from when it settles, not when it started", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				const gate = yield* Deferred.make<void>()
				const slow = yield* Effect.forkChild(
					read(keyOf("org_a", "slow"), Effect.andThen(Deferred.await(gate), load)),
				)
				yield* Effect.yieldNow
				const shas = Array.from({ length: READ_CACHE_MAX_ENTRIES - 1 }, (_, index) => `sha${index}`)
				yield* Effect.forEach(shas, (sha) => read(keyOf("org_a", sha), load), { discard: true })
				yield* Deferred.succeed(gate, undefined)
				yield* Fiber.join(slow)
				yield* read(keyOf("org_a", "new"), load)
				const before = yield* Ref.get(runs)
				// `sha0` is now the least recently read and goes; the slow read just settled and stays.
				yield* read(keyOf("org_a", "slow"), load)
				expect(yield* Ref.get(runs)).toBe(before)
			}),
		))

	test("a refresh reads again and replaces the entry", () =>
		run(
			Effect.gen(function* () {
				const { load } = yield* counting
				yield* read(keyOf("org_a"), load)
				expect(yield* read(keyOf("org_a"), load, true)).toEqual({ count: 2 })
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 2 })
			}),
		))

	test("a failure reaches its readers but is not kept", () =>
		run(
			Effect.gen(function* () {
				const { runs, load } = yield* counting
				const failing = Effect.andThen(load, Effect.fail("down"))
				expect(Exit.isFailure(yield* Effect.exit(read(keyOf("org_a"), failing)))).toBe(true)
				expect(yield* read(keyOf("org_a"), load)).toEqual({ count: 2 })
				expect(yield* Ref.get(runs)).toBe(2)
			}),
		))

	test("a cached value that fails the reader's schema is read again", () =>
		run(
			Effect.gen(function* () {
				const cache = yield* Effect.service(ReadCache)
				const Named = Schema.Struct({ name: Schema.String })
				yield* read(keyOf("org_a"), Effect.succeed({ count: 7 }))
				const reread = cache.read(
					{ key: keyOf("org_a"), idleTtlMs: TTL_MS, schema: Named },
					Effect.succeed({ name: "x" }),
				)
				expect(yield* reread).toEqual({ name: "x" })
			}),
		))
})
