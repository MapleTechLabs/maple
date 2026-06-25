import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeEdgeCacheService, makeMemoryBackend } from "@maple/query-engine/caching"
import { CUSTOMER_CACHE_BUCKET, readCustomerCached } from "./autumn.http"

const ORG = "org_test_123"

const makeCache = () => makeEdgeCacheService(makeMemoryBackend())

describe("readCustomerCached", () => {
	it.effect("caches a 200 response: 2nd call hits the cache, upstream runs once", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 200, response: { customer: ORG, calls } }
			})

			const first = yield* readCustomerCached(cache, ORG, run)
			const second = yield* readCustomerCached(cache, ORG, run)

			assert.strictEqual(calls, 1)
			assert.isFalse(first.hit)
			assert.isTrue(second.hit)
			assert.deepStrictEqual(second.result.response, { customer: ORG, calls: 1 })
		}),
	)

	it.effect("does NOT cache a non-200 response — recomputes on every call", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 500, response: { error: "boom" } }
			})

			const first = yield* readCustomerCached(cache, ORG, run)
			const second = yield* readCustomerCached(cache, ORG, run)

			assert.strictEqual(calls, 2)
			assert.isFalse(first.hit)
			assert.isFalse(second.hit)
			assert.strictEqual(first.result.statusCode, 500)
		}),
	)

	it.effect("recomputes after the org entry is invalidated", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 200, response: { calls } }
			})

			yield* readCustomerCached(cache, ORG, run)
			yield* readCustomerCached(cache, ORG, run) // served from cache
			yield* cache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: ORG })
			const after = yield* readCustomerCached(cache, ORG, run)

			assert.strictEqual(calls, 2)
			assert.isFalse(after.hit)
			assert.deepStrictEqual(after.result.response, { calls: 2 })
		}),
	)

	it.effect("scopes the cache per org — a different orgId is a separate entry", () =>
		Effect.gen(function* () {
			const cache = makeCache()
			let calls = 0
			const run = Effect.sync(() => {
				calls += 1
				return { statusCode: 200, response: { calls } }
			})

			yield* readCustomerCached(cache, "org_a", run)
			yield* readCustomerCached(cache, "org_b", run)

			assert.strictEqual(calls, 2)
		}),
	)
})
