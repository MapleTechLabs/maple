import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { makeEdgeCacheService, makeMemoryBackend } from "@maple/query-engine/caching"
import { CUSTOMER_CACHE_BUCKET, readCustomerCached } from "./autumn.http"

const ORG = "org_test_123"

const makeCache = () => makeEdgeCacheService(makeMemoryBackend())

describe("readCustomerCached", () => {
	it("caches a 200 response: 2nd call hits the cache, upstream runs once", async () => {
		const cache = makeCache()
		let calls = 0
		const run = Effect.sync(() => {
			calls += 1
			return { statusCode: 200, response: { customer: ORG, calls } }
		})

		const { first, second } = await Effect.runPromise(
			Effect.gen(function* () {
				const first = yield* readCustomerCached(cache, ORG, run)
				const second = yield* readCustomerCached(cache, ORG, run)
				return { first, second }
			}),
		)

		expect(calls).toBe(1)
		expect(first.hit).toBe(false)
		expect(second.hit).toBe(true)
		expect(second.result.response).toEqual({ customer: ORG, calls: 1 })
	})

	it("does NOT cache a non-200 response — recomputes on every call", async () => {
		const cache = makeCache()
		let calls = 0
		const run = Effect.sync(() => {
			calls += 1
			return { statusCode: 500, response: { error: "boom" } }
		})

		const { first, second } = await Effect.runPromise(
			Effect.gen(function* () {
				const first = yield* readCustomerCached(cache, ORG, run)
				const second = yield* readCustomerCached(cache, ORG, run)
				return { first, second }
			}),
		)

		expect(calls).toBe(2)
		expect(first.hit).toBe(false)
		expect(second.hit).toBe(false)
		expect(first.result.statusCode).toBe(500)
	})

	it("recomputes after the org entry is invalidated", async () => {
		const cache = makeCache()
		let calls = 0
		const run = Effect.sync(() => {
			calls += 1
			return { statusCode: 200, response: { calls } }
		})

		const after = await Effect.runPromise(
			Effect.gen(function* () {
				yield* readCustomerCached(cache, ORG, run)
				yield* readCustomerCached(cache, ORG, run) // served from cache
				yield* cache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: ORG })
				return yield* readCustomerCached(cache, ORG, run)
			}),
		)

		expect(calls).toBe(2)
		expect(after.hit).toBe(false)
		expect(after.result.response).toEqual({ calls: 2 })
	})

	it("scopes the cache per org — a different orgId is a separate entry", async () => {
		const cache = makeCache()
		let calls = 0
		const run = Effect.sync(() => {
			calls += 1
			return { statusCode: 200, response: { calls } }
		})

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* readCustomerCached(cache, "org_a", run)
				yield* readCustomerCached(cache, "org_b", run)
			}),
		)

		expect(calls).toBe(2)
	})
})
