import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { Array as Arr, Duration, Effect, Layer, Option, Order, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import * as PG from "@maple-dev/effect-orm/postgres"
import { SourceMapFiles } from "@maple/db/tables"
import { SOURCE_MAP_MAX_BYTES } from "@maple/domain/http"
import { SourceMapFileId } from "@maple/primitives"
import { inMemoryObjectStore, sourceMapBucketLayer } from "@maple/backend/platform/bindings"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { SourceMapReader } from "./SourceMapReader"
import { claimExpired, SOURCE_MAP_RETENTION, SourceMapService } from "./SourceMapService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_maps")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_maps_other")
const DEBUG_ID = "6c5e2b1a-1f2e-4d3c-8b7a-0123456789ab"

const makeHarness = (database: Layer.Layer<Database> = createTestDb(createdDbs).layer) => {
	const objects = new Map<string, Uint8Array>()
	const store = inMemoryObjectStore(objects)
	const layer = Layer.mergeAll(
		Layer.effect(SourceMapService, SourceMapService.make),
		Layer.effect(SourceMapReader, SourceMapReader.make),
	).pipe(Layer.provideMerge(database), Layer.provide(sourceMapBucketLayer(store)))
	return { objects, store, layer }
}

const mapBytes = (fields: Record<string, unknown> = {}) =>
	new TextEncoder().encode(
		JSON.stringify({ version: 3, sources: ["src/a.ts"], names: [], mappings: "AAAA", ...fields }),
	)

describe("SourceMapService.upload", () => {
	it.effect("replaces the file with the same debug id, object included", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const first = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/a.js",
				debugId: Str.toUpperCase(DEBUG_ID),
			})
			const second = yield* service.upload(ORG, {
				bytes: mapBytes({ sourcesContent: ["export const a = 1"] }),
				minifiedPath: "/assets/a-renamed.js",
				debugId: DEBUG_ID,
			})
			yield* service.upload(OTHER_ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/a.js",
				debugId: DEBUG_ID,
			})

			const rows = yield* service.list(ORG, { limit: 10, offset: 0 })
			expect(
				Arr.map(rows, (row) => [row.id, row.debugId, row.minifiedPath, row.hasSourcesContent]),
			).toEqual([[second.id, DEBUG_ID, "assets/a-renamed.js", true]])
			expect(objects.has(first.objectKey)).toBe(false)
			const reader = yield* SourceMapReader
			expect(Option.getOrNull(yield* reader.load(second))).toContain("export const a = 1")
			expect(objects.size).toBe(2)
		}).pipe(Effect.provide(layer))
	})

	it.effect("replaces by service, version and path when there is no debug id", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const release = { serviceName: "web", version: "1.2.0" }
			const first = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/a.js",
				...release,
			})
			yield* service.upload(ORG, { bytes: mapBytes(), minifiedPath: "assets/b.js", ...release })
			yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/a.js",
				serviceName: "web",
				version: "1.3.0",
			})
			const replacement = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "./assets/a.js",
				...release,
			})

			const rows = yield* service.list(ORG, {
				serviceName: "web",
				version: "1.2.0",
				limit: 10,
				offset: 0,
			})
			expect(
				Arr.sort(
					Arr.map(rows, (row) => row.minifiedPath),
					Order.String,
				),
			).toEqual(["assets/a.js", "assets/b.js"])
			expect(Arr.some(rows, (row) => row.id === replacement.id)).toBe(true)
			expect(objects.has(first.objectKey)).toBe(false)
		}).pipe(Effect.provide(layer))
	})

	it.effect("replaces a concurrent upload of the same map that committed first", () => {
		const objects = new Map<string, Uint8Array>()
		const winnerId = Schema.decodeSync(SourceMapFileId)("0f0e0d0c-0b0a-4908-8706-050403020100")
		const winnerKey = `v1/${ORG}/${winnerId}`
		const insertWinner = PG.insertInto(SourceMapFiles).values({
			id: winnerId,
			orgId: ORG,
			debugId: DEBUG_ID,
			serviceName: null,
			version: null,
			minifiedPath: "assets/a.js",
			sizeBytes: 1,
			hasSourcesContent: false,
			objectKey: winnerKey,
			createdAt: 0,
			lastUsedAt: null,
		})
		const state = { raced: false }
		// The first row write loses the race: the other upload's row lands, then ours hits the
		// unique index (a real 23505 from Postgres).
		const racing = Layer.effect(
			Database,
			Effect.map(Database, (database) => ({
				...database,
				execute: <A, E, R>(fn: Parameters<typeof database.execute<A, E, R>>[0]) =>
					Effect.suspend(() => {
						if (state.raced) return database.execute(fn)
						state.raced = true
						objects.set(winnerKey, mapBytes())
						return database
							.execute((db) => db.run(insertWinner))
							.pipe(
								Effect.orDie,
								Effect.andThen(database.execute((db) => db.run(insertWinner))),
								Effect.andThen(database.execute(fn)),
							)
					}),
			})),
		).pipe(Layer.provide(createTestDb(createdDbs).layer))
		const layer = Layer.mergeAll(
			Layer.effect(SourceMapService, SourceMapService.make),
			Layer.effect(SourceMapReader, SourceMapReader.make),
		).pipe(Layer.provide(racing), Layer.provide(sourceMapBucketLayer(inMemoryObjectStore(objects))))
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const row = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/a.js",
				debugId: DEBUG_ID,
			})
			expect(state.raced).toBe(true)
			const rows = yield* service.list(ORG, { limit: 10, offset: 0 })
			expect(Arr.map(rows, (r) => r.id)).toEqual([row.id])
			expect(objects.has(winnerKey)).toBe(false)
			expect(objects.has(row.objectKey)).toBe(true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps the uploaded object when the row write fails, for the orphan sweep", () => {
		const objects = new Map<string, Uint8Array>()
		const other = PG.insertInto(SourceMapFiles).values({
			id: Schema.decodeSync(SourceMapFileId)("0f0e0d0c-0b0a-4908-8706-050403020101"),
			orgId: OTHER_ORG,
			debugId: null,
			serviceName: "web",
			version: "1",
			minifiedPath: "other.js",
			sizeBytes: 1,
			hasSourcesContent: false,
			objectKey: "v1/other",
			createdAt: 0,
			lastUsedAt: null,
		})
		// Every row write fails (a duplicate key), as a lost commit ack would look to the caller.
		const failing = Layer.effect(
			Database,
			Effect.map(Database, (database) => ({
				...database,
				execute: <A, E, R>(fn: Parameters<typeof database.execute<A, E, R>>[0]) =>
					database
						.execute((db) => db.run(other))
						.pipe(
							Effect.ignore,
							Effect.andThen(database.execute((db) => db.run(other))),
							Effect.andThen(database.execute(fn)),
						),
			})),
		).pipe(Layer.provide(createTestDb(createdDbs).layer))
		const layer = Layer.effect(SourceMapService, SourceMapService.make).pipe(
			Layer.provide(failing),
			Layer.provide(sourceMapBucketLayer(inMemoryObjectStore(objects))),
		)
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const error = yield* service
				.upload(ORG, { bytes: mapBytes(), minifiedPath: "assets/a.js", debugId: DEBUG_ID })
				.pipe(Effect.flip)
			expect(error._tag).toBe("@maple/http/sourcemaps/SourceMapStorageError")
			expect(objects.size).toBe(1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("adopts the debug id the map itself carries", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const row = yield* service.upload(ORG, {
				bytes: mapBytes({ debug_id: DEBUG_ID }),
				minifiedPath: "assets/a.js",
			})
			expect(row.debugId).toBe(DEBUG_ID)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps builds with their own debug ids apart on one release path", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const path = { minifiedPath: "assets/main.js", serviceName: "web", version: "1.4.2" }
			const releaseOnly = yield* service.upload(ORG, { bytes: mapBytes(), ...path })
			const first = yield* service.upload(ORG, { bytes: mapBytes(), debugId: DEBUG_ID, ...path })
			const second = yield* service.upload(ORG, {
				bytes: mapBytes(),
				debugId: "7d6f3c2b-2a3f-4e4d-9c8b-123456789abc",
				...path,
			})
			const rows = yield* service.list(ORG, { limit: 10, offset: 0 })
			expect(
				Arr.sort(
					Arr.map(rows, (row) => row.id),
					Order.String,
				),
			).toEqual(Arr.sort([releaseOnly.id, first.id, second.id], Order.String))
			expect(Arr.every([first, second, releaseOnly], (row) => objects.has(row.objectKey))).toBe(true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps the stored map when a replacement is not usable", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const release = { minifiedPath: "assets/main.js", serviceName: "web", version: "2.4.0" }
			const stored = yield* service.upload(ORG, { bytes: mapBytes(), ...release })
			const unusable = [
				mapBytes({ sources: undefined }),
				mapBytes({ sources: [] }),
				mapBytes({ sources: [1] }),
				mapBytes({ mappings: undefined, sections: [{ offset: { line: 0 }, map: {} }] }),
			]
			const errors = yield* Effect.forEach(unusable, (bytes) =>
				service.upload(ORG, { bytes, ...release }).pipe(
					Effect.flip,
					Effect.map((error) => error._tag),
				),
			)
			expect(Arr.dedupe(errors)).toEqual(["@maple/http/sourcemaps/SourceMapInvalidError"])
			const rows = yield* service.list(ORG, { limit: 10, offset: 0 })
			expect(Arr.map(rows, (row) => row.id)).toEqual([stored.id])
			expect([...objects.keys()]).toEqual([stored.objectKey])
		}).pipe(Effect.provide(layer))
	})

	it.effect("accepts an index map whose sections are usable maps", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const section = { version: 3, sources: ["src/a.ts"], names: [], mappings: "AAAA" }
			const row = yield* service.upload(ORG, {
				bytes: new TextEncoder().encode(
					JSON.stringify({
						version: 3,
						sections: [{ offset: { line: 0, column: 0 }, map: section }],
					}),
				),
				minifiedPath: "assets/a.js",
				debugId: DEBUG_ID,
			})
			expect(row.debugId).toBe(DEBUG_ID)
		}).pipe(Effect.provide(layer))
	})

	it.effect("rejects what is not a usable source map, storing nothing", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const reject = (input: Parameters<typeof service.upload>[1]) =>
				service.upload(ORG, input).pipe(
					Effect.flip,
					Effect.map((error) => [error._tag, "param" in error ? error.param : undefined]),
				)
			const base = { minifiedPath: "assets/a.js", debugId: DEBUG_ID }

			expect(yield* reject({ ...base, bytes: new TextEncoder().encode("not json") })).toEqual([
				"@maple/http/sourcemaps/SourceMapInvalidError",
				undefined,
			])
			expect(yield* reject({ ...base, bytes: mapBytes({ version: 2 }) })).toEqual([
				"@maple/http/sourcemaps/SourceMapInvalidError",
				undefined,
			])
			expect(
				yield* reject({ ...base, bytes: mapBytes({ mappings: undefined, sections: [] }) }),
			).toEqual(["@maple/http/sourcemaps/SourceMapInvalidError", undefined])
			expect(yield* reject({ ...base, bytes: mapBytes(), debugId: "not-a-uuid" })).toEqual([
				"@maple/http/sourcemaps/SourceMapInvalidError",
				"debug_id",
			])
			expect(
				yield* reject({ bytes: mapBytes(), minifiedPath: "assets/a.js", serviceName: "web" }),
			).toEqual(["@maple/http/sourcemaps/SourceMapInvalidError", "debug_id"])
			expect(yield* reject({ ...base, bytes: mapBytes(), minifiedPath: " / " })).toEqual([
				"@maple/http/sourcemaps/SourceMapInvalidError",
				"minified_path",
			])
			expect(yield* reject({ ...base, bytes: new Uint8Array(SOURCE_MAP_MAX_BYTES + 1) })).toEqual([
				"@maple/http/sourcemaps/SourceMapTooLargeError",
				undefined,
			])

			expect(yield* service.list(ORG, { limit: 10, offset: 0 })).toEqual([])
			expect(objects.size).toBe(0)
		}).pipe(Effect.provide(layer))
	})
})

describe("SourceMapReader.findForFrames", () => {
	it.effect("prefers the debug id, then the release path at a slash boundary", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const reader = yield* SourceMapReader
			const release = { serviceName: "web", version: "1.2.0" }
			const byDebugId = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "elsewhere/main.js",
				debugId: DEBUG_ID,
			})
			const byPath = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/main.js",
				...release,
			})
			const deeper = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "v2/assets/main.js",
				...release,
			})
			yield* service.upload(ORG, { bytes: mapBytes(), minifiedPath: "vendor.js", ...release })

			const withDebugId = "https://cdn.test/assets/main.js"
			const nested = "https://cdn.test/static/v2/assets/main.js?v=3"
			const plain = "https://cdn.test/static/assets/main.js"
			const boundary = "https://cdn.test/static/my-vendor.js"
			const otherDebugId = "https://cdn.test/assets/other.js"
			const matches = yield* reader.findForFrames({
				orgId: ORG,
				debugIds: new Map([
					[withDebugId, Str.toUpperCase(DEBUG_ID)],
					[otherDebugId, "00000000-0000-4000-8000-000000000000"],
				]),
				...release,
				urls: [withDebugId, nested, plain, boundary, otherDebugId],
			})
			expect(matches.get(withDebugId)?.id).toBe(byDebugId.id)
			expect(matches.get(nested)?.id).toBe(deeper.id)
			expect(matches.get(plain)?.id).toBe(byPath.id)
			expect(matches.has(boundary)).toBe(false)
			expect(matches.has(otherDebugId)).toBe(false)

			const otherOrg = yield* reader.findForFrames({
				orgId: OTHER_ORG,
				debugIds: new Map([[withDebugId, DEBUG_ID]]),
				...release,
				urls: [withDebugId, plain],
			})
			expect(otherOrg.size).toBe(0)
		}).pipe(Effect.provide(layer))
	})
	it.effect("on a shared release path, prefers the map without a debug id, else the newest", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const reader = yield* SourceMapReader
			const release = { serviceName: "web", version: "1.2.0" }
			const url = "https://cdn.test/assets/main.js"
			const find = Effect.map(
				reader.findForFrames({ orgId: ORG, debugIds: new Map(), ...release, urls: [url] }),
				(matches) => matches.get(url)?.id,
			)
			yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/main.js",
				debugId: DEBUG_ID,
				...release,
			})
			yield* TestClock.adjust(Duration.seconds(1))
			const newer = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/main.js",
				debugId: "7d6f3c2b-2a3f-4e4d-9c8b-123456789abc",
				...release,
			})
			expect(yield* find).toBe(newer.id)
			const releaseOnly = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/main.js",
				...release,
			})
			yield* TestClock.adjust(Duration.seconds(1))
			yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/main.js",
				debugId: "8e7a4d3c-3b4a-4f5e-8d9c-23456789abcd",
				...release,
			})
			expect(yield* find).toBe(releaseOnly.id)
		}).pipe(Effect.provide(layer))
	})

	it.effect("matches percent-encoded frame URLs to the decoded stored path", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const reader = yield* SourceMapReader
			const release = { serviceName: "web", version: "1.2.0" }
			const spaced = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/my file.js",
				...release,
			})
			const fromUrl = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "https://cdn.test/assets/%5Bid%5D-page.js",
				...release,
			})
			expect(fromUrl.minifiedPath).toBe("assets/[id]-page.js")

			const encoded = "https://cdn.test/assets/my%20file.js"
			const bracketed = "https://cdn.test/assets/%5Bid%5D-page.js"
			const malformed = "https://cdn.test/assets/%E0%A4%A.js"
			const matches = yield* reader.findForFrames({
				orgId: ORG,
				debugIds: new Map(),
				...release,
				urls: [encoded, bracketed, malformed],
			})
			expect(matches.get(encoded)?.id).toBe(spaced.id)
			expect(matches.get(bracketed)?.id).toBe(fromUrl.id)
			expect(matches.has(malformed)).toBe(false)
		}).pipe(Effect.provide(layer))
	})
})

describe("SourceMapService.sweepExpired", () => {
	it.effect("deletes files unused for 90 days, counting a touch as use", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const stale = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "a.js",
				debugId: DEBUG_ID,
			})
			const used = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "b.js",
				serviceName: "web",
				version: "1",
			})
			yield* TestClock.adjust(Duration.days(60))
			yield* (yield* SourceMapReader).touch(ORG, [used.id])
			yield* TestClock.adjust(Duration.days(31))
			const fresh = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "c.js",
				serviceName: "web",
				version: "1",
			})

			const deleted = yield* service.sweepExpired(Duration.toMillis(Duration.days(91)))
			expect(deleted).toBe(1)
			const left = yield* service.list(ORG, { limit: 10, offset: 0 })
			expect(
				Arr.sort(
					Arr.map(left, (row) => row.id),
					Order.String,
				),
			).toEqual(Arr.sort([used.id, fresh.id], Order.String))
			expect(objects.has(stale.objectKey)).toBe(false)

			const later = Duration.toMillis(Duration.days(60)) + Duration.toMillis(SOURCE_MAP_RETENTION) + 1
			expect(yield* service.sweepExpired(later)).toBe(1)
		}).pipe(Effect.provide(layer))
	})
})

describe("claimExpired", () => {
	it.effect("keeps a map whose use was recorded after the sweep selected it", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const database = yield* Database
			const touched = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "a.js",
				debugId: DEBUG_ID,
			})
			const idle = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "b.js",
				serviceName: "web",
				version: "1",
			})
			yield* TestClock.adjust(Duration.days(91))
			const cutoff = Duration.toMillis(Duration.days(1))
			// Both were expired when selected; one is used before the claim runs.
			yield* (yield* SourceMapReader).touch(ORG, [touched.id])
			const claimed = yield* claimExpired(database, [touched.id, idle.id], cutoff)
			expect(claimed).toEqual([idle.objectKey])
			const left = yield* service.list(ORG, { limit: 10, offset: 0 })
			expect(Arr.map(left, (row) => row.id)).toEqual([touched.id])
			expect(objects.has(touched.objectKey)).toBe(true)
		}).pipe(Effect.provide(layer))
	})
})

describe("SourceMapService.sweepOrphans", () => {
	it.effect("deletes day-old objects no row points at and keeps everything else", () => {
		const { objects, store, layer } = makeHarness()
		return Effect.gen(function* () {
			const service = yield* SourceMapService
			const kept = yield* service.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "a.js",
				debugId: DEBUG_ID,
			})
			const orphanKey = `v1/${ORG}/1a2b3c4d-0000-4000-8000-000000000001`
			const foreignKey = `v1/${ORG}/not-a-file-id`
			yield* store.put(orphanKey, mapBytes(), "application/json")
			yield* store.put(foreignKey, mapBytes(), "application/json")
			yield* TestClock.adjust(Duration.days(2))
			const freshKey = `v1/${ORG}/1a2b3c4d-0000-4000-8000-000000000002`
			yield* store.put(freshKey, mapBytes(), "application/json")

			expect(yield* service.sweepOrphans(Duration.toMillis(Duration.days(2)))).toBe(1)
			expect(objects.has(orphanKey)).toBe(false)
			expect(objects.has(kept.objectKey)).toBe(true)
			expect(objects.has(foreignKey)).toBe(true)
			expect(objects.has(freshKey)).toBe(true)
		}).pipe(Effect.provide(layer))
	})
})
