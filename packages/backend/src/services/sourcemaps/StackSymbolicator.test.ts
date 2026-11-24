import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { Array as Arr, Deferred, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	inMemoryObjectStore,
	ObjectStoreError,
	sourceMapBucketLayer,
	type WritableObjectStore,
} from "@maple/backend/platform/bindings"
import * as PG from "@maple-dev/effect-orm/postgres"
import { SourceMapFiles, type SourceMapFileRow } from "@maple/db/tables"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { SourceMapReader } from "./SourceMapReader"
import { SourceMapService } from "./SourceMapService"
import {
	PARSED_MAP_SIZE_FACTOR,
	type SymbolicateRequest,
	StackSymbolicator,
	SYMBOLICATION_MAX_MAP_BYTES,
} from "./StackSymbolicator"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeSync(OrgId)("org_symbolicator")
const DEBUG_ID = "6c5e2b1a-1f2e-4d3c-8b7a-0123456789ab"
const BUNDLE_URL = "https://shop.example.com/assets/index-Bx81.js"
const STACK = `TypeError: boom\n    at a (${BUNDLE_URL}:1:1)`

const APP_SOURCE = Arr.join(
	Arr.makeBy(14, (i) => `// app line ${i + 1}`),
	"\n",
)

// One segment: generated 1:0 -> src/app.ts 7:0, named handleClick (`AAMAA` is [0, 0, +6, 0, 0]).
const mapBytes = (mappings = "AAMAA") =>
	new TextEncoder().encode(
		JSON.stringify({
			version: 3,
			sources: ["webpack://shop/./src/app.ts"],
			sourcesContent: [APP_SOURCE],
			names: ["handleClick"],
			mappings,
		}),
	)

const RESOLVED_FRAME = {
	raw: `at a (${BUNDLE_URL}:1:1)`,
	// A lone frame has no caller call site to name it, so it keeps its minified name.
	function: "a",
	file: "src/app.ts",
	line: 7,
	column: 1,
	in_app: true,
	resolved: true,
	context: {
		pre: Arr.makeBy(5, (i) => `// app line ${i + 2}`),
		line: "// app line 7",
		post: Arr.makeBy(5, (i) => `// app line ${i + 8}`),
	},
}

const request = (overrides: Partial<SymbolicateRequest> = {}): SymbolicateRequest => ({
	orgId: ORG,
	stacktrace: STACK,
	serviceName: null,
	serviceVersion: null,
	debugIds: new Map(),
	...overrides,
})

interface BucketState {
	reads: number
	failReads: boolean
	/** While set, reads wait for it. */
	gate: Deferred.Deferred<void> | undefined
	/** Completed when a read starts (before it waits on the gate). */
	readStarted: Deferred.Deferred<void> | undefined
	/** Completed when a frame lookup returns. */
	lookedUp: Deferred.Deferred<void> | undefined
	/** Frame lookups made (each is one or more Postgres reads). */
	lookups: number
}

/** An in-memory bucket that counts reads and can be made to fail or hold them. */
const makeHarness = () => {
	const objects = new Map<string, Uint8Array>()
	const state: BucketState = {
		reads: 0,
		failReads: false,
		gate: undefined,
		readStarted: undefined,
		lookedUp: undefined,
		lookups: 0,
	}
	const signal = (deferred: Deferred.Deferred<void> | undefined) =>
		deferred === undefined ? Effect.void : Deferred.succeed(deferred, undefined)
	const memory = inMemoryObjectStore(objects)
	const bucket: WritableObjectStore = {
		...memory,
		getBytes: (key) =>
			Effect.suspend(() => {
				state.reads += 1
				const read = state.failReads
					? Effect.fail(new ObjectStoreError({ message: "bucket unavailable", cause: undefined }))
					: memory.getBytes(key)
				const started = signal(state.readStarted)
				return state.gate === undefined
					? Effect.andThen(started, read)
					: Effect.andThen(started, Effect.andThen(Deferred.await(state.gate), read))
			}),
	}
	const sourceMaps = Layer.mergeAll(
		Layer.effect(SourceMapService, SourceMapService.make),
		Layer.effect(
			SourceMapReader,
			Effect.map(SourceMapReader.make, (reader) => ({
				...reader,
				findForFrames: (lookup: Parameters<typeof reader.findForFrames>[0]) =>
					Effect.tap(reader.findForFrames(lookup), () =>
						Effect.andThen(
							Effect.sync(() => {
								state.lookups += 1
							}),
							signal(state.lookedUp),
						),
					),
			})),
		),
	).pipe(Layer.provideMerge(createTestDb(createdDbs).layer), Layer.provide(sourceMapBucketLayer(bucket)))
	const layer = Layer.effect(StackSymbolicator, StackSymbolicator.make).pipe(Layer.provideMerge(sourceMaps))
	return { state, layer, objects }
}

/**
 * Forks `run` twice: the first is let through to its (gated) bucket read, the second only once
 * that read is blocked, and is returned once its lookup is done and it is waiting on that load.
 */
const joinedLoad = <A>(state: BucketState, run: Effect.Effect<A>) =>
	Effect.gen(function* () {
		state.readStarted = yield* Deferred.make<void>()
		const loading = yield* Effect.forkChild(run)
		yield* Deferred.await(state.readStarted)
		state.readStarted = undefined
		state.lookedUp = yield* Deferred.make<void>()
		const waiting = yield* Effect.forkChild(run)
		yield* Deferred.await(state.lookedUp)
		state.lookedUp = undefined
		// From its lookup to waiting on the shared load the fiber does no I/O; let it run there.
		yield* Effect.yieldNow
		yield* Effect.yieldNow
		return [loading, waiting] as const
	})

describe("StackSymbolicator", () => {
	it.effect("resolves a frame through the map its debug id names, whatever the file is called", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/renamed-later.js",
				debugId: DEBUG_ID,
			})

			const stack = yield* symbolicator.symbolicate(
				request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) }),
			)
			assert.deepStrictEqual(stack, { status: "resolved", frames: [RESOLVED_FRAME], missing: [] })
		}).pipe(Effect.provide(layer))
	})

	it.effect("falls back to service, version and path, and marks the file used", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const release = { serviceName: "shop-web", version: "2.4.0" }
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				...release,
			})

			const otherVersion = yield* symbolicator.symbolicate(
				request({ serviceName: "shop-web", serviceVersion: "2.3.0" }),
			)
			assert.strictEqual(otherVersion.status, "missing_map")
			assert.deepStrictEqual(otherVersion.missing, [BUNDLE_URL])

			const stack = yield* symbolicator.symbolicate(
				request({ serviceName: "shop-web", serviceVersion: "2.4.0" }),
			)
			assert.deepStrictEqual(stack.frames, [RESOLVED_FRAME])
			const [row] = yield* sourceMaps.list(ORG, { limit: 1, offset: 0 })
			assert.isNotNull(row?.lastUsedAt ?? null)
		}).pipe(Effect.provide(layer))
	})

	it.effect("parses a map once and serves later stacks from the cache", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })

			const first = yield* symbolicator.symbolicate(withDebugId)
			const second = yield* symbolicator.symbolicate(withDebugId)
			assert.strictEqual(state.reads, 1)
			assert.deepStrictEqual(second, first)
			assert.strictEqual(second.status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	it.effect("remembers a URL with no map for five minutes, then finds a late upload", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const release = request({ serviceName: "shop-web", serviceVersion: "2.4.0" })
			// The org has a map, so the miss comes from the URL lookup, not the org's no-maps answer.
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/unrelated.js",
				debugId: DEBUG_ID,
			})

			assert.strictEqual((yield* symbolicator.symbolicate(release)).status, "missing_map")
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				serviceName: "shop-web",
				version: "2.4.0",
			})
			assert.strictEqual((yield* symbolicator.symbolicate(release)).status, "missing_map")
			// Past the one-minute org cache, the URL is still remembered as missing.
			yield* TestClock.adjust(Duration.minutes(2))
			assert.strictEqual((yield* symbolicator.symbolicate(release)).status, "missing_map")

			yield* TestClock.adjust(Duration.minutes(3))
			assert.strictEqual((yield* symbolicator.symbolicate(release)).status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	it.effect("leaves frames unresolved when the bucket fails, and tries again next time", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })

			state.failReads = true
			const failed = yield* symbolicator.symbolicate(withDebugId)
			assert.strictEqual(failed.status, "missing_map")
			assert.deepStrictEqual(
				Arr.map(failed.frames, (frame) => [frame.file, frame.line, frame.resolved]),
				[[BUNDLE_URL, 1, false]],
			)

			state.failReads = false
			assert.strictEqual((yield* symbolicator.symbolicate(withDebugId)).status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers a stack with no JavaScript files without looking anything up", () => {
		const unreachable = Layer.succeed(SourceMapReader, {
			hasAny: () => Effect.die("hasAny"),
			findForFrames: () => Effect.die("findForFrames"),
			load: () => Effect.die("load"),
			touch: () => Effect.die("touch"),
		})
		return Effect.gen(function* () {
			const symbolicator = yield* StackSymbolicator
			const python = yield* symbolicator.symbolicate(
				request({
					stacktrace: 'Traceback (most recent call last):\n  File "app.py", line 3, in <module>',
				}),
			)
			assert.deepStrictEqual(python, { status: "not_applicable", frames: [], missing: [] })
			const java = yield* symbolicator.symbolicate(
				request({
					stacktrace: "java.lang.IllegalStateException\n\tat com.shop.Cart.add(Cart.java:42)",
				}),
			)
			assert.strictEqual(java.status, "not_applicable")
			assert.deepStrictEqual(java.missing, [])
		}).pipe(
			Effect.provide(
				Layer.effect(StackSymbolicator, StackSymbolicator.make).pipe(Layer.provide(unreachable)),
			),
		)
	})
	it.effect("skips a map over the symbolication limit, leaving its frames unresolved", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const row = yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			// Records the file as over the limit without building one that large.
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.update(SourceMapFiles)
						.set({ sizeBytes: SYMBOLICATION_MAX_MAP_BYTES + 1 })
						.where(($) => [$.id.eq(row.id)]),
				),
			)

			const stack = yield* symbolicator.symbolicate(
				request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) }),
			)
			assert.strictEqual(stack.status, "missing_map")
			assert.strictEqual(state.reads, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("looks nothing up for an org with no maps, and notices its first upload", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })

			assert.isFalse(yield* symbolicator.hasSourceMaps(ORG))
			const none = yield* symbolicator.symbolicate(withDebugId)
			assert.strictEqual(none.status, "missing_map")
			assert.deepStrictEqual(none.missing, [BUNDLE_URL])

			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			yield* TestClock.adjust(Duration.minutes(1))
			assert.isTrue(yield* symbolicator.hasSourceMaps(ORG))
			assert.strictEqual((yield* symbolicator.symbolicate(withDebugId)).status, "resolved")
			assert.strictEqual(state.reads, 1)
		}).pipe(Effect.provide(layer))
	})
	it.live("shares one load between concurrent stacks and counts a cached map once", () => {
		const { state, layer } = makeHarness()
		const OTHER_ID = "7d6f3c2b-2a3f-4e4d-9c8b-1234567890ab"
		const OTHER_URL = "https://shop.example.com/assets/chunk-Zz91.js"
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const database = yield* Database
			const first = yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			const second = yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/chunk-Zz91.js",
				debugId: OTHER_ID,
			})
			// Each parsed map is estimated at just under half the cache, so both fit only when
			// every map is counted once.
			const nearHalf = Math.floor((40 * 1024 * 1024) / 2 / PARSED_MAP_SIZE_FACTOR) - 1024
			yield* database.execute((db) =>
				db.run(
					PG.update(SourceMapFiles)
						.set({ sizeBytes: nearHalf })
						.where(($) => [PG.inList($.id, [first.id, second.id])]),
				),
			)
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })

			const gate = yield* Deferred.make<void>()
			state.gate = gate
			const fibers = yield* joinedLoad(state, symbolicator.symbolicate(withDebugId))
			yield* Deferred.succeed(gate, undefined)
			state.gate = undefined
			const stacks = yield* Fiber.joinAll(fibers)
			assert.deepStrictEqual(
				Arr.map(stacks, (stack) => stack.status),
				["resolved", "resolved"],
			)
			assert.strictEqual(state.reads, 1)

			const other = yield* symbolicator.symbolicate(
				request({
					stacktrace: `TypeError: boom\n    at a (${OTHER_URL}:1:1)`,
					debugIds: new Map([[OTHER_URL, OTHER_ID]]),
				}),
			)
			assert.strictEqual(other.status, "resolved")
			assert.strictEqual((yield* symbolicator.symbolicate(withDebugId)).status, "resolved")
			assert.strictEqual(state.reads, 2)
		}).pipe(Effect.provide(layer))
	})

	it.live("leaves stacks waiting on an interrupted load unresolved, and loads again later", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })

			state.gate = yield* Deferred.make<void>()
			const [loading, waiting] = yield* joinedLoad(
				state,
				symbolicator.symbolicateWithOutcome(withDebugId),
			)
			if (loading === undefined || waiting === undefined) return assert.fail("both fibers start")
			yield* Fiber.interrupt(loading)
			const waited = yield* Fiber.join(waiting)
			assert.deepStrictEqual([waited.stack.status, waited.lookupFailed], ["missing_map", true])

			state.gate = undefined
			assert.strictEqual((yield* symbolicator.symbolicate(withDebugId)).status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	it.effect("says when a map read failed", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })
			state.failReads = true
			const failed = yield* symbolicator.symbolicateWithOutcome(withDebugId)
			assert.isTrue(failed.lookupFailed)
			state.failReads = false
			const ok = yield* symbolicator.symbolicateWithOutcome(withDebugId)
			assert.deepStrictEqual([ok.lookupFailed, ok.stack.status], [false, "resolved"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps two builds with their own debug ids on one release path apart", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const OTHER_DEBUG_ID = "7d6f3c2b-2a3f-4e4d-9c8b-123456789abc"
			const release = {
				serviceName: "shop-web",
				version: "2.4.0",
				minifiedPath: "assets/index-Bx81.js",
			}
			yield* sourceMaps.upload(ORG, { bytes: mapBytes(), debugId: DEBUG_ID, ...release })
			// The second build maps the same position to line 11 (`AAUAA` is [0, 0, +10, 0, 0]).
			yield* sourceMaps.upload(ORG, { bytes: mapBytes("AAUAA"), debugId: OTHER_DEBUG_ID, ...release })
			assert.strictEqual((yield* sourceMaps.list(ORG, { limit: 10, offset: 0 })).length, 2)

			const lineFor = (debugId: string) =>
				Effect.map(
					symbolicator.symbolicate(
						request({
							serviceName: "shop-web",
							serviceVersion: "2.4.0",
							debugIds: new Map([[BUNDLE_URL, debugId]]),
						}),
					),
					(stack) => stack.frames[0]?.line,
				)
			assert.strictEqual(yield* lineFor(DEBUG_ID), 7)
			assert.strictEqual(yield* lineFor(OTHER_DEBUG_ID), 11)
		}).pipe(Effect.provide(layer))
	})

	it.effect("records use only for a map that resolved a frame", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			// Line 5 has no mapping: the map loads but resolves nothing.
			const unmapped = yield* symbolicator.symbolicate(
				request({
					stacktrace: `TypeError: boom\n    at a (${BUNDLE_URL}:5:1)`,
					debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]),
				}),
			)
			assert.strictEqual(unmapped.status, "missing_map")
			const [untouched] = yield* sourceMaps.list(ORG, { limit: 1, offset: 0 })
			assert.isNull(untouched?.lastUsedAt ?? null)

			yield* symbolicator.symbolicate(request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) }))
			const [touched] = yield* sourceMaps.list(ORG, { limit: 1, offset: 0 })
			assert.isNotNull(touched?.lastUsedAt ?? null)
		}).pipe(Effect.provide(layer))
	})

	it.effect("loads no more maps for one stack than its memory budget", () => {
		const { state, layer } = makeHarness()
		const OTHER_ID = "7d6f3c2b-2a3f-4e4d-9c8b-1234567890ab"
		const OTHER_URL = "https://shop.example.com/assets/chunk-Zz91.js"
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const database = yield* Database
			const rows = yield* Effect.forEach(
				[
					["assets/index-Bx81.js", DEBUG_ID],
					["assets/chunk-Zz91.js", OTHER_ID],
				] as const,
				([minifiedPath, debugId]) =>
					sourceMaps.upload(ORG, { bytes: mapBytes(), minifiedPath, debugId }),
			)
			// Each estimated at 36 MiB: one fits the 64 MiB budget, two do not.
			yield* database.execute((db) =>
				db.run(
					PG.update(SourceMapFiles)
						.set({ sizeBytes: 6 * 1024 * 1024 })
						.where(($) => [
							PG.inList(
								$.id,
								Arr.map(rows, (row) => row.id),
							),
						]),
				),
			)
			const stack = yield* symbolicator.symbolicate(
				request({
					stacktrace: `TypeError: boom\n    at a (${BUNDLE_URL}:1:1)\n    at b (${OTHER_URL}:1:1)`,
					debugIds: new Map([
						[BUNDLE_URL, DEBUG_ID],
						[OTHER_URL, OTHER_ID],
					]),
				}),
			)
			assert.deepStrictEqual(
				Arr.map(stack.frames, (frame) => frame.resolved),
				[true, false],
			)
			assert.strictEqual(state.reads, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("counts a matched map whose object is gone as a failed read", () => {
		const { objects, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const row = yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			// Replaced or deleted between the lookup and the read: the row is there, its bytes are not.
			objects.delete(row.objectKey)
			const outcome = yield* symbolicator.symbolicateWithOutcome(
				request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) }),
			)
			assert.deepStrictEqual([outcome.stack.status, outcome.lookupFailed], ["missing_map", true])
		}).pipe(Effect.provide(layer))
	})

	it.effect("looks up a URL with no JS extension when the SDK recorded its debug id", () => {
		const { layer } = makeHarness()
		const BLOB_URL = "blob:https://shop.example.com/0f3a9c1e-6b2d-4e8f-9a7c-1d2e3f4a5b6c"
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, { bytes: mapBytes(), minifiedPath: "worker.js", debugId: DEBUG_ID })
			const stacktrace = `TypeError: boom\n    at a (${BLOB_URL}:1:1)`
			const withId = yield* symbolicator.symbolicate(
				request({ stacktrace, debugIds: new Map([[BLOB_URL, DEBUG_ID]]) }),
			)
			assert.deepStrictEqual(
				Arr.map(withId.frames, (frame) => [frame.file, frame.line]),
				[["src/app.ts", 7]],
			)
			const without = yield* symbolicator.symbolicate(request({ stacktrace }))
			assert.isFalse(without.frames[0]?.resolved ?? true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("looks a bundle up once for a whole batch of its stacks", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				serviceName: "shop-web",
				version: "2.4.0",
			})
			const lookupMemo = new Map<string, SourceMapFileRow>()
			const stacks = yield* Effect.forEach(
				Arr.makeBy(200, () =>
					request({ serviceName: "shop-web", serviceVersion: "2.4.0", lookupMemo }),
				),
				(req) => symbolicator.symbolicate(req),
				{ concurrency: 4 },
			)
			assert.isTrue(Arr.every(stacks, (stack) => stack.status === "resolved"))
			assert.isAtMost(state.lookups, 4)
			assert.strictEqual(state.reads, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("looks again when a batch's remembered map was replaced since", () => {
		const { objects, state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const release = {
				serviceName: "shop-web",
				version: "2.4.0",
				minifiedPath: "assets/index-Bx81.js",
			}
			const first = yield* sourceMaps.upload(ORG, { bytes: mapBytes(), ...release })
			const lookupMemo = new Map<string, SourceMapFileRow>()
			const req = request({ serviceName: "shop-web", serviceVersion: "2.4.0", lookupMemo })
			const withFirst = yield* symbolicator.symbolicateWithOutcome(req)
			assert.strictEqual(withFirst.stack.frames[0]?.line, 7)
			// Replaced, and the old map dropped from this isolate's parsed cache by a bigger one.
			yield* sourceMaps.upload(ORG, { bytes: mapBytes("AAUAA"), ...release })
			assert.isFalse(objects.has(first.objectKey))
			const replacedAndEvicted = Arr.makeBy(9, (i) => `assets/filler-${i}.js`)
			yield* Effect.forEach(replacedAndEvicted, (minifiedPath, i) =>
				Effect.andThen(
					sourceMaps.upload(ORG, {
						bytes: mapBytes(),
						minifiedPath,
						debugId: `00000000-0000-4000-8000-00000000000${i}`,
					}),
					(row) =>
						symbolicator.symbolicate(
							request({
								stacktrace: `TypeError: boom\n    at a (https://shop.example.com/${minifiedPath}:1:1)`,
								debugIds: new Map([
									[`https://shop.example.com/${minifiedPath}`, row.debugId ?? ""],
								]),
							}),
						),
				),
			)
			const stale = yield* symbolicator.symbolicateWithOutcome(req)
			assert.deepStrictEqual([stale.stack.status, stale.lookupFailed], ["missing_map", true])
			const lookupsBefore = state.lookups
			const fresh = yield* symbolicator.symbolicateWithOutcome(req)
			assert.strictEqual(fresh.stack.frames[0]?.line, 11)
			assert.strictEqual(state.lookups, lookupsBefore + 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("parses a map over the cache budget once, keeping it as the only entry", () => {
		const { state, layer } = makeHarness()
		return Effect.gen(function* () {
			const sourceMaps = yield* SourceMapService
			const symbolicator = yield* StackSymbolicator
			const database = yield* Database
			const row = yield* sourceMaps.upload(ORG, {
				bytes: mapBytes(),
				minifiedPath: "assets/index-Bx81.js",
				debugId: DEBUG_ID,
			})
			// 7 MiB estimates to 42 MiB, over the 40 MiB cache budget.
			yield* database.execute((db) =>
				db.run(
					PG.update(SourceMapFiles)
						.set({ sizeBytes: 7 * 1024 * 1024 })
						.where(($) => [PG.inList($.id, [row.id])]),
				),
			)
			const withDebugId = request({ debugIds: new Map([[BUNDLE_URL, DEBUG_ID]]) })
			yield* symbolicator.symbolicate(withDebugId)
			yield* symbolicator.symbolicate(withDebugId)
			assert.strictEqual(state.reads, 1)
		}).pipe(Effect.provide(layer))
	})
})
