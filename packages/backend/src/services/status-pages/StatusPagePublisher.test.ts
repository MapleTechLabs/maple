import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { decodeStatusPageSnapshotJson, StatusPageKeys } from "@maple/domain/status-page"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { StatusPagePublisher } from "./StatusPagePublisher"
import { StatusPageStore, type InMemoryStatusPageStore } from "./StatusPageStore"
import { bumpRevision, NOW, newPageId, readPage, seedComponent, seedPage } from "./status-page-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

/** Runs `body` with a publisher over a fresh database and an in-memory store. */
const withPublisher = <A, E>(
	body: (ctx: {
		readonly testDb: TestDb
		readonly store: InMemoryStatusPageStore
		readonly publisher: StatusPagePublisher["Service"]
	}) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const testDb = createTestDb(trackedDbs)
		const store = yield* StatusPageStore.makeInMemory
		const layer = StatusPagePublisher.layer.pipe(
			Layer.provide(Layer.succeed(StatusPageStore, store.api)),
			Layer.provide(testDb.layer),
		)
		return yield* StatusPagePublisher.use((publisher) => body({ testDb, store, publisher })).pipe(
			Effect.provide(layer),
		)
	})

describe("StatusPagePublisher.publish", () => {
	it.effect("writes the snapshot and routes, then advances published_revision", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme", revision: 3 })
				yield* seedComponent(testDb, { id: crypto.randomUUID(), pageId, name: "API", position: 0 })

				const result = yield* publisher.publish(pageId)
				assert.isTrue(result.written)
				const { kv, objects } = yield* store.contents
				const snapshot = decodeStatusPageSnapshotJson(kv.get(StatusPageKeys.snapshot(pageId)))
				assert.isTrue(Option.isSome(snapshot))
				if (Option.isSome(snapshot)) {
					assert.strictEqual(snapshot.value.revision, 3)
					assert.deepStrictEqual(
						snapshot.value.components.map((c) => c.name),
						["API"],
					)
				}
				assert.strictEqual(
					objects.get(StatusPageKeys.snapshotObject(pageId)),
					kv.get(StatusPageKeys.snapshot(pageId)),
				)
				assert.strictEqual(kv.get(StatusPageKeys.slug("acme")), pageId)
				const row = yield* readPage(testDb, pageId)
				assert.strictEqual(row?.published_revision, "3")
				assert.isNotNull(row?.published_hash)
			}),
		),
	)

	it.effect("skips the edge write when nothing visible changed", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-same" })
				yield* publisher.publish(pageId)
				const first = (yield* store.contents).kv.get(StatusPageKeys.snapshot(pageId))

				yield* bumpRevision(testDb, pageId)
				yield* TestClock.adjust("1 minute")
				const second = yield* publisher.publish(pageId)
				assert.isFalse(second.written)
				assert.strictEqual((yield* store.contents).kv.get(StatusPageKeys.snapshot(pageId)), first)
				assert.strictEqual((yield* readPage(testDb, pageId))?.published_revision, "2")
			}),
		),
	)

	it.effect("records the store failure and leaves published_revision behind", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-down", revision: 2 })
				yield* store.setFailing(true)
				const exit = yield* Effect.exit(publisher.publish(pageId))
				assert.isTrue(Exit.isFailure(exit))
				const row = yield* readPage(testDb, pageId)
				assert.strictEqual(row?.published_revision, "0")
				assert.include(row?.last_publish_error ?? "", "kv.put")

				yield* store.setFailing(false)
				yield* publisher.publish(pageId)
				assert.isNull((yield* readPage(testDb, pageId))?.last_publish_error)
			}),
		),
	)
})

describe("StatusPagePublisher.sweep", () => {
	it.effect("publishes only lagging or stale pages", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const lagging = newPageId()
				const current = newPageId()
				const stale = newPageId()
				yield* seedPage(testDb, {
					id: lagging,
					slug: "lagging",
					revision: 2,
					publishedRevision: 1,
					publishedAt: NOW,
				})
				yield* seedPage(testDb, {
					id: current,
					slug: "current",
					revision: 1,
					publishedRevision: 1,
					publishedAt: NOW,
				})
				yield* seedPage(testDb, {
					id: stale,
					slug: "stale",
					revision: 1,
					publishedRevision: 1,
					publishedAt: NOW - 20 * 60_000,
				})

				const result = yield* publisher.sweep(NOW)
				assert.strictEqual(result.due, 2)
				const { kv } = yield* store.contents
				assert.isTrue(kv.has(StatusPageKeys.snapshot(lagging)))
				assert.isTrue(kv.has(StatusPageKeys.snapshot(stale)))
				assert.isFalse(kv.has(StatusPageKeys.snapshot(current)))
			}),
		),
	)

	it.effect("keeps going past a page that fails", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const first = newPageId()
				const second = newPageId()
				yield* seedPage(testDb, { id: first, slug: "first" })
				yield* seedPage(testDb, { id: second, slug: "second" })
				yield* store.setFailing((key) => key.includes(first))

				const partial = yield* publisher.sweep(NOW)
				assert.deepStrictEqual(partial, { due: 2, written: 1, unchanged: 0, failed: 1 })
				assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.snapshot(second)))

				yield* store.setFailing(false)
				const recovered = yield* publisher.sweep(NOW)
				assert.deepStrictEqual(recovered, { due: 1, written: 1, unchanged: 0, failed: 0 })
				assert.deepStrictEqual(yield* publisher.sweep(NOW), {
					due: 0,
					written: 0,
					unchanged: 0,
					failed: 0,
				})
			}),
		),
	)

	it.effect("writes the heartbeat", () =>
		withPublisher(({ store, publisher }) =>
			Effect.gen(function* () {
				yield* publisher.heartbeat(NOW)
				assert.strictEqual(
					(yield* store.contents).kv.get(StatusPageKeys.heartbeat),
					JSON.stringify({ at: NOW }),
				)
			}),
		),
	)
})
