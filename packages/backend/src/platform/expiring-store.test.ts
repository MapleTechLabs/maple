import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { makeExpiringStore } from "./expiring-store"

describe("ExpiringStore", () => {
	it.effect("evicts an expired entry when it is read", () =>
		Effect.gen(function* () {
			const store = yield* makeExpiringStore<string>()
			yield* store.set("installation-1", "token", 1_000)
			assert.deepStrictEqual(yield* store.get("installation-1"), Option.some("token"))
			yield* TestClock.adjust(2_000)
			assert.deepStrictEqual(yield* store.get("installation-1"), Option.none())
			assert.strictEqual(yield* store.size, 0)
		}),
	)

	it.effect("reads inside the skew as expired, and evicts it", () =>
		Effect.gen(function* () {
			const store = yield* makeExpiringStore<string>()
			yield* store.set("installation-1", "token", 1_000)
			assert.deepStrictEqual(yield* store.get("installation-1", 1_000), Option.none())
			assert.strictEqual(yield* store.size, 0)
		}),
	)

	it.effect("stays under its bound: expired entries go first, then the soonest to expire", () =>
		Effect.gen(function* () {
			const store = yield* makeExpiringStore<string>(2)
			yield* store.set("a", "a", 1_000)
			yield* store.set("b", "b", 5_000)
			yield* TestClock.adjust(2_000)
			yield* store.set("c", "c", 9_000)
			assert.strictEqual(yield* store.size, 2)
			assert.deepStrictEqual(yield* store.get("b"), Option.some("b"))
			yield* store.set("d", "d", 9_000)
			assert.strictEqual(yield* store.size, 2)
			assert.deepStrictEqual(yield* store.get("b"), Option.none())
			assert.deepStrictEqual(yield* store.get("c"), Option.some("c"))
			// Refreshing a held key evicts nothing.
			yield* store.set("d", "d2", 9_000)
			assert.deepStrictEqual(yield* store.get("c"), Option.some("c"))
		}),
	)

	it.effect("removes every entry whose value matches", () =>
		Effect.gen(function* () {
			const store = yield* makeExpiringStore<{ readonly token: string }>()
			yield* store.set("installation-1", { token: "revoked" }, 9_000)
			yield* store.set("installation-2", { token: "fine" }, 9_000)
			yield* store.removeWhere(({ token }) => token === "revoked")
			assert.deepStrictEqual(yield* store.get("installation-1"), Option.none())
			assert.deepStrictEqual(yield* store.get("installation-2"), Option.some({ token: "fine" }))
		}),
	)
})
