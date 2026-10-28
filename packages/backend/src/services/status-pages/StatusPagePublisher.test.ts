import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { decodeStatusPageSnapshotJson, StatusPageKeys, utcDay } from "@maple/domain/status-page"
import { StatusPageId } from "@maple/domain/primitives"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { STATUS_PAGE_SWEEP_BATCH, StatusPagePublisher } from "./StatusPagePublisher"
import { StatusPageStore, type InMemoryStatusPageStore } from "./StatusPageStore"
import {
	bumpRevision,
	cleanupRows,
	DAY_MS,
	NOW,
	newPageId,
	readPage,
	seedCleanup,
	seedComponent,
	seedDaily,
	seedMonitor,
	seedPage,
} from "./status-page-test-support"

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
				// The edge's fallback when KV fails.
				assert.strictEqual(objects.get(StatusPageKeys.slugObject("acme")), pageId)
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

	it.effect("stores the hash of a stale republish without bumping the page again", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, {
					id: pageId,
					slug: "acme-stale",
					revision: 4,
					publishedRevision: 4,
					publishedAt: NOW - 20 * 60_000,
				})
				const result = yield* publisher.publish(pageId)
				assert.isTrue(result.written)
				assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.snapshot(pageId)))
				const row = yield* readPage(testDb, pageId)
				assert.strictEqual(row?.revision, "4")
				assert.strictEqual(row?.published_revision, "4")
				assert.isNotNull(row?.published_hash)
				// The stored hash makes the next stale republish a no-op write.
				assert.isFalse((yield* publisher.publish(pageId)).written)
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

				const counts = { cleaned: 0, cleanupsFailed: 0 }
				const partial = yield* publisher.sweep(NOW)
				assert.deepStrictEqual(partial, { due: 2, written: 1, unchanged: 0, failed: 1, ...counts })
				assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.snapshot(second)))
				// A failed attempt still counts, so it waits behind pages not yet tried.
				assert.isNotNull((yield* readPage(testDb, first))?.publish_attempted_at)

				yield* store.setFailing(false)
				const recovered = yield* publisher.sweep(NOW)
				assert.deepStrictEqual(recovered, { due: 1, written: 1, unchanged: 0, failed: 0, ...counts })
				assert.deepStrictEqual(yield* publisher.sweep(NOW), {
					due: 0,
					written: 0,
					unchanged: 0,
					failed: 0,
					...counts,
				})
			}),
		),
	)

	it.effect("takes the longest-waiting attempts first, so a page never tried before is not starved", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				// Sorts last by id, so an id-ordered sweep would never reach it.
				const starved = StatusPageId.make("ffffffff-ffff-4fff-8fff-ffffffffffff")
				yield* seedPage(testDb, { id: starved, slug: "starved", publishAttemptedAt: null })
				yield* Effect.forEach(
					Array.from({ length: STATUS_PAGE_SWEEP_BATCH }, (_, index) => index),
					(index) =>
						seedPage(testDb, {
							id: newPageId(),
							slug: `busy-${index}`,
							publishAttemptedAt: NOW - 60_000,
						}),
					{ discard: true },
				)
				const result = yield* publisher.sweep(NOW)
				assert.strictEqual(result.due, STATUS_PAGE_SWEEP_BATCH)
				assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.snapshot(starved)))
			}),
		),
	)

	it.effect("writes the heartbeat with the newest scheduled check after a sweep", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const probe = crypto.randomUUID()
				const heartbeatMonitor = crypto.randomUUID()
				const paused = crypto.randomUUID()
				yield* seedMonitor(testDb, { id: probe, status: "up" })
				yield* seedMonitor(testDb, { id: heartbeatMonitor, status: "up", kind: "heartbeat" })
				yield* seedMonitor(testDb, { id: paused, status: "up", enabled: false })
				const daily = (monitorId: string, day: string, lastCheckAt: number) =>
					seedDaily(testDb, { monitorId, day, checks: 1, failures: 0, downChecks: 0, lastCheckAt })
				yield* daily(probe, utcDay(NOW - DAY_MS), NOW - DAY_MS)
				yield* daily(probe, utcDay(NOW), NOW - 90_000)
				// Neither a heartbeat's synthetic miss nor a paused monitor proves the probes run.
				yield* daily(heartbeatMonitor, utcDay(NOW), NOW - 1_000)
				yield* daily(paused, utcDay(NOW), NOW - 2_000)

				yield* publisher.sweep(NOW)
				assert.strictEqual(
					(yield* store.contents).kv.get(StatusPageKeys.heartbeat),
					JSON.stringify({ at: NOW, probesSeenAt: NOW - 90_000 }),
				)
			}),
		),
	)

	it.effect("writes no heartbeat when the sweep cannot read the database", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				yield* Effect.promise(() =>
					executeSql(testDb, `ALTER TABLE status_pages RENAME TO status_pages_gone`, []),
				)
				const exit = yield* Effect.exit(publisher.sweep(NOW))
				assert.isTrue(Exit.isFailure(exit))
				assert.isFalse((yield* store.contents).kv.has(StatusPageKeys.heartbeat))
			}),
		),
	)
})

describe("StatusPagePublisher.sweep edge cleanups", () => {
	it.effect("drops a renamed page's old slug route, in KV and R2, and the queue row", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "old-name" })
				yield* publisher.sweep(NOW)
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`UPDATE status_pages SET slug = 'new-name', revision = revision + 1 WHERE id = $1`,
						[pageId],
					),
				)
				yield* seedCleanup(testDb, { pageId, slug: "old-name", deleteSnapshot: false, at: NOW })

				const result = yield* publisher.sweep(NOW + 60_000)
				assert.strictEqual(result.cleaned, 1)
				const { kv, objects } = yield* store.contents
				assert.isFalse(kv.has(StatusPageKeys.slug("old-name")))
				assert.isFalse(objects.has(StatusPageKeys.slugObject("old-name")))
				assert.strictEqual(kv.get(StatusPageKeys.slug("new-name")), pageId)
				assert.isTrue(kv.has(StatusPageKeys.snapshot(pageId)))
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)

	it.effect("keeps a live page's edge data when its delete never committed", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "still-here" })
				yield* publisher.sweep(NOW)
				// Queued by an org purge that failed after the queue insert committed.
				yield* seedCleanup(testDb, { pageId, slug: "still-here", deleteSnapshot: true, at: NOW })
				yield* publisher.sweep(NOW + 60_000)
				const { kv } = yield* store.contents
				assert.isTrue(kv.has(StatusPageKeys.snapshot(pageId)))
				assert.strictEqual(kv.get(StatusPageKeys.slug("still-here")), pageId)
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)

	it.effect("leaves a slug route alone once another page owns that slug", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const renamed = newPageId()
				const taker = newPageId()
				yield* seedPage(testDb, { id: taker, slug: "shared" })
				yield* publisher.sweep(NOW)
				// The rename's cleanup drains after the new owner already took the slug.
				yield* seedCleanup(testDb, {
					pageId: renamed,
					slug: "shared",
					deleteSnapshot: false,
					at: NOW,
				})
				yield* publisher.sweep(NOW + 60_000)
				const { kv, objects } = yield* store.contents
				assert.strictEqual(kv.get(StatusPageKeys.slug("shared")), taker)
				assert.strictEqual(objects.get(StatusPageKeys.slugObject("shared")), taker)
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)

	it.effect("removes a deleted page's snapshot, routes and break-glass entries", () =>
		withPublisher(({ testDb, store, publisher }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const other = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "doomed" })
				yield* seedPage(testDb, { id: other, slug: "kept" })
				yield* publisher.sweep(NOW)
				yield* store.putKv(StatusPageKeys.overlayEntry(pageId, "e1"), "{}")
				yield* store.putKv(StatusPageKeys.overlayEntry(pageId, "e2"), "{}")
				yield* store.putKv(StatusPageKeys.overlayEntry(other, "e3"), "{}")
				yield* Effect.promise(() =>
					executeSql(testDb, `DELETE FROM status_pages WHERE id = $1`, [pageId]),
				)
				yield* seedCleanup(testDb, { pageId, slug: "doomed", deleteSnapshot: true, at: NOW })

				// A failing edge delete keeps the row for the next sweep.
				yield* store.setFailing((key) => key === StatusPageKeys.snapshotObject(pageId))
				const failed = yield* publisher.sweep(NOW + 60_000)
				assert.deepStrictEqual([failed.cleaned, failed.cleanupsFailed], [0, 1])
				assert.strictEqual((yield* cleanupRows(testDb)).length, 1)

				yield* store.setFailing(false)
				const done = yield* publisher.sweep(NOW + 120_000)
				assert.strictEqual(done.cleaned, 1)
				const { kv, objects } = yield* store.contents
				assert.isFalse(kv.has(StatusPageKeys.snapshot(pageId)))
				assert.isFalse(objects.has(StatusPageKeys.snapshotObject(pageId)))
				assert.isFalse(kv.has(StatusPageKeys.slug("doomed")))
				assert.isFalse(objects.has(StatusPageKeys.slugObject("doomed")))
				assert.isFalse(kv.has(StatusPageKeys.overlayEntry(pageId, "e1")))
				assert.isFalse(kv.has(StatusPageKeys.overlayEntry(pageId, "e2")))
				assert.isTrue(kv.has(StatusPageKeys.overlayEntry(other, "e3")))
				assert.isTrue(kv.has(StatusPageKeys.snapshot(other)))
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)
})
