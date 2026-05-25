import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { QueryEngineExecuteResponse } from "@maple/query-engine"
import { EdgeCacheService, makeEdgeCacheService, type EdgeCacheBackend } from "./EdgeCacheService"

/**
 * In-memory backend that mirrors the Workers cache JSON-roundtrip:
 * `put` stringifies, `get` parses. This is what the production Workers
 * backend does — necessary to exercise the schema decode path that the
 * default in-process memory backend (which stores by reference) never hits.
 */
const makeJsonRoundtripBackend = (): EdgeCacheBackend & {
	store: Map<string, string>
} => {
	const store = new Map<string, string>()
	const composite = (bucket: string, hash: string) => `${bucket}:${hash}`
	return {
		store,
		get: async (bucket, hash) => {
			const raw = store.get(composite(bucket, hash))
			if (raw === undefined) return undefined
			return JSON.parse(raw) as unknown
		},
		put: async (bucket, hash, value) => {
			store.set(composite(bucket, hash), JSON.stringify(value))
		},
	}
}

const makeLayer = (backend: EdgeCacheBackend) =>
	Layer.succeed(EdgeCacheService, makeEdgeCacheService(backend))

describe("EdgeCacheService.getOrCompute (no schema)", () => {
	it.effect("round-trips a plain object through the JSON cache backend", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return { hello: "world", n: 42 }
			})
			const first = yield* cache.getOrCompute({ bucket: "plain", key: "k1", ttlSeconds: 30 }, compute)
			const second = yield* cache.getOrCompute({ bucket: "plain", key: "k1", ttlSeconds: 30 }, compute)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(first.hit, false)
			assert.deepStrictEqual(first.value, { hello: "world", n: 42 })
			assert.strictEqual(second.hit, true)
			assert.deepStrictEqual(second.value, { hello: "world", n: 42 })
		}).pipe(Effect.provide(makeLayer(backend)))
	})
})

describe("EdgeCacheService.getOrCompute (with Schema.Class schema)", () => {
	it.effect("revives a Schema.Class instance after a JSON-roundtrip cache hit", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		const buildResponse = () =>
			new QueryEngineExecuteResponse({
				result: {
					kind: "timeseries" as const,
					source: "metrics" as const,
					data: [
						{ bucket: "2026-04-23T22:00:00.000Z", series: {} },
						{ bucket: "2026-04-23T23:00:00.000Z", series: { v: 1 } },
					],
				},
			})

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return buildResponse()
			})
			const first = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k1",
					ttlSeconds: 30,
					schema: QueryEngineExecuteResponse,
				},
				compute,
			)
			const second = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k1",
					ttlSeconds: 30,
					schema: QueryEngineExecuteResponse,
				},
				compute,
			)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(first.hit, false)
			assert.instanceOf(first.value, QueryEngineExecuteResponse)
			assert.strictEqual(second.hit, true)
			// The whole point of the fix: the cache HIT must give us back a real
			// class instance, not a plain object — otherwise the HTTP API encoder
			// rejects it with `Expected QueryEngineExecuteResponse, got {...}`.
			assert.instanceOf(second.value, QueryEngineExecuteResponse)
			assert.strictEqual(second.value.result.kind, "timeseries")
			if (second.value.result.kind === "timeseries") {
				assert.strictEqual(second.value.result.data.length, 2)
			}
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("treats a stale-shape cache entry as a miss and recomputes", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			// Pre-populate the cache with a value that does NOT match the schema.
			// The schema-aware decode should fail and the call should fall through
			// to the compute path, then overwrite the bad entry.
			const composite = "qe:" // bucket prefix
			const sha256Hex = (input: string): Promise<string> =>
				crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then((digest) => {
					const view = new Uint8Array(digest)
					let out = ""
					for (let i = 0; i < view.length; i++) {
						out += view[i]!.toString(16).padStart(2, "0")
					}
					return out
				})
			const hash = yield* Effect.promise(() => sha256Hex("k-stale"))
			backend.store.set(`${composite}${hash}`, JSON.stringify({ wrong: "shape" }))

			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries" as const,
						source: "logs" as const,
						data: [{ bucket: "2026-04-23T22:00:00.000Z", series: { c: 7 } }],
					},
				})
			})
			const result = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k-stale",
					ttlSeconds: 30,
					schema: QueryEngineExecuteResponse,
				},
				compute,
			)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(result.hit, false)
			assert.instanceOf(result.value, QueryEngineExecuteResponse)
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("dedupes concurrent callers; both receive a class instance", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries" as const,
						source: "traces" as const,
						data: [{ bucket: "2026-04-23T22:00:00.000Z", series: { x: 5 } }],
					},
				})
			})
			const opts = {
				bucket: "qe",
				key: "k-concurrent",
				ttlSeconds: 30,
				schema: QueryEngineExecuteResponse,
			} as const
			const [a, b] = yield* Effect.all(
				[cache.getOrCompute(opts, compute), cache.getOrCompute(opts, compute)],
				{ concurrency: "unbounded" },
			)

			// Compute should run at most once thanks to in-flight dedup. Both
			// results must be live class instances (the dedup path returns the
			// pre-encode value without going through decode).
			assert.strictEqual(computeCalls, 1)
			assert.instanceOf(a.value, QueryEngineExecuteResponse)
			assert.instanceOf(b.value, QueryEngineExecuteResponse)
		}).pipe(Effect.provide(makeLayer(backend)))
	})
})
