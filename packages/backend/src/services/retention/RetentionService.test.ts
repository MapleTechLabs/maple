import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Deferred, Effect, Fiber, Layer, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, SourceId, UserId } from "@maple/domain/http"
import { EdgeCacheService } from "@maple/cache"
import { DEFAULT_RETENTION_DAYS, RETENTION_SIGNALS } from "@maple/domain/retention"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	makeSwitchableDatabase,
	queryFirstRow,
	testEdgeCache,
	TestReadHorizonMemoLive,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import {
	DEFAULT_READ_HORIZON,
	READ_HORIZON_CACHE_BUCKET,
	READ_HORIZON_CACHE_KEY,
	READ_HORIZON_LOAD_TIMEOUT_MS,
	READ_HORIZON_RETRY_MS,
	READ_HORIZON_TTL_MS,
	RetentionService,
} from "./RetentionService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_retention")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_elsewhere")
const ANA = Schema.decodeSync(UserId)("user_ana")
const BEN = Schema.decodeSync(UserId)("user_ben")
const decodeSourceId = Schema.decodeSync(SourceId)

const withDb = <A, E>(run: (db: TestDb) => Effect.Effect<A, E, RetentionService>) => {
	const db = createTestDb(trackedDbs)
	return run(db).pipe(
		Effect.provide(
			RetentionService.layer.pipe(
				Layer.provide(Layer.mergeAll(db.layer, testEdgeCache(db), TestReadHorizonMemoLive)),
			),
		),
	)
}

/** The service over a database that counts its calls and can be switched off. */
const withSwitchableDb = <A, E>(
	run: (
		database: ReturnType<typeof makeSwitchableDatabase>["state"],
		db: TestDb,
	) => Effect.Effect<A, E, RetentionService>,
) => {
	const db = createTestDb(trackedDbs)
	const database = makeSwitchableDatabase(db)
	return run(database.state, db).pipe(
		Effect.provide(
			RetentionService.layer.pipe(
				Layer.provide(Layer.mergeAll(database.layer, testEdgeCache(db), TestReadHorizonMemoLive)),
			),
		),
	)
}

/** A write from elsewhere: another instance over the same database, as another isolate is. */
const fromAnotherIsolate = <A, E>(db: TestDb, effect: Effect.Effect<A, E, RetentionService>) =>
	effect.pipe(
		Effect.provide(
			Layer.fresh(RetentionService.layer).pipe(
				Layer.provide(
					Layer.mergeAll(db.layer, testEdgeCache(db), Layer.fresh(TestReadHorizonMemoLive)),
				),
			),
		),
	)

const source = (db: TestDb, orgId: OrgId, platform: string) =>
	Effect.map(
		Effect.promise(() => insertTestSource(db, { orgId, platform })),
		decodeSourceId,
	)

describe("RetentionService", () => {
	it.effect("an organization that set nothing keeps the defaults, and reads reach as far", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const policy = yield* retention.get(ORG)
				assert.deepStrictEqual(policy.overrides, {})
				assert.deepStrictEqual(policy.days, DEFAULT_RETENTION_DAYS)
				assert.deepStrictEqual(policy.readHorizonDays, DEFAULT_RETENTION_DAYS)
				assert.deepStrictEqual(policy.sources, [])
			}),
		),
	)

	it.effect("an organization's period replaces the default for that signal only", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const policy = yield* retention.setOrganization(ORG, ANA, { traces: 60, logs: 7 })
				assert.deepStrictEqual(policy.days, { ...DEFAULT_RETENTION_DAYS, traces: 60, logs: 7 })
				assert.deepStrictEqual(policy.readHorizonDays, policy.days)
				assert.deepStrictEqual(yield* retention.get(ORG), policy)
			}),
		),
	)

	it.effect("setting again replaces the earlier periods instead of merging into them", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 60, logs: 7 })
				const policy = yield* retention.setOrganization(ORG, ANA, { metrics: 365 })
				assert.deepStrictEqual(policy.overrides, { metrics: 365 })
				assert.deepStrictEqual(policy.days, { ...DEFAULT_RETENTION_DAYS, metrics: 365 })
			}),
		),
	)

	it.effect("a source keeps its own period for the signals it sets and inherits the rest", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* source(db, ORG, "python")
				yield* retention.setOrganization(ORG, ANA, { traces: 60 })
				const policy = yield* retention.setSource(ORG, ANA, debug, { traces: 3, logs: 90 })
				assert.deepStrictEqual(policy.sources, [
					{
						sourceId: debug,
						overrides: { traces: 3, logs: 90 },
						days: { ...DEFAULT_RETENTION_DAYS, traces: 3, logs: 90 },
					},
				])
				// The organization's own periods are unchanged by one source.
				assert.deepStrictEqual(policy.days, { ...DEFAULT_RETENTION_DAYS, traces: 60 })
			}),
		),
	)

	it.effect("reads reach as far as the longest source, and no shorter than the organization", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const short = yield* source(db, ORG, "nodejs")
				const long = yield* source(db, ORG, "python")
				yield* retention.setSource(ORG, ANA, short, { traces: 3 })
				const policy = yield* retention.setSource(ORG, ANA, long, { logs: 365 })
				assert.strictEqual(policy.readHorizonDays.traces, DEFAULT_RETENTION_DAYS.traces)
				assert.strictEqual(policy.readHorizonDays.logs, 365)
			}),
		),
	)

	it.effect("clearing a source's periods makes it inherit again", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setSource(ORG, ANA, debug, { logs: 365 })
				const policy = yield* retention.setSource(ORG, ANA, debug, {})
				assert.deepStrictEqual(policy.sources, [])
				assert.deepStrictEqual(policy.readHorizonDays, DEFAULT_RETENTION_DAYS)
			}),
		),
	)

	it.effect("another organization's source cannot be changed, and its periods stay out of the policy", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const theirs = yield* source(db, OTHER_ORG, "nodejs")
				yield* retention.setSource(OTHER_ORG, ANA, theirs, { traces: 365 })
				yield* retention.setOrganization(OTHER_ORG, ANA, { logs: 365 })

				const refused = yield* Effect.result(retention.setSource(ORG, ANA, theirs, { traces: 3 }))
				assert.isTrue(Result.isFailure(refused))
				if (Result.isFailure(refused))
					assert.strictEqual(refused.failure._tag, "@maple/http/errors/SourceNotFoundError")

				const policy = yield* retention.get(ORG)
				assert.deepStrictEqual(policy.days, DEFAULT_RETENTION_DAYS)
				assert.deepStrictEqual(policy.readHorizonDays, DEFAULT_RETENTION_DAYS)
				const stored = yield* Effect.promise(() =>
					queryFirstRow<{ retention_days: unknown }>(
						db,
						"SELECT retention_days FROM sources WHERE id = $1",
						[theirs],
					),
				)
				assert.deepStrictEqual(stored?.retention_days, { traces: 365 })
			}),
		),
	)

	it.effect("two concurrent edits of different signals both land, each with what it changed from", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const [traces, logs] = yield* Effect.all(
					[
						retention.updateOrganization(ORG, ANA, (current) => ({ ...current, traces: 7 })),
						retention.updateOrganization(ORG, ANA, (current) => ({ ...current, logs: 90 })),
					],
					{ concurrency: 2 },
				)
				const policy = yield* retention.get(ORG)
				assert.deepStrictEqual(policy.overrides, { traces: 7, logs: 90 })
				// Whichever ran second saw the first one's write.
				assert.isTrue(traces.before.logs === 90 || logs.before.traces === 7)
			}),
		),
	)

	it.effect("refuses a period that cannot be stored, as a bad request and without writing", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setOrganization(ORG, ANA, { logs: 730 })
				const offTheList = yield* Effect.result(retention.setOrganization(ORG, ANA, { logs: 45 }))
				const fraction = yield* Effect.result(retention.setSource(ORG, ANA, debug, { traces: 1.5 }))
				for (const refused of [offTheList, fraction]) {
					assert.isTrue(Result.isFailure(refused))
					if (Result.isFailure(refused)) {
						assert.strictEqual(
							refused.failure._tag,
							"@maple/http/retention/RetentionInvalidError",
						)
					}
				}
				const policy = yield* retention.get(ORG)
				assert.deepStrictEqual(policy.overrides, { logs: 730 })
				assert.deepStrictEqual(policy.sources, [])
			}),
		),
	)

	it.effect("a write that changes nothing leaves the stored row and who changed it alone", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 60 })
				const updatedBy = () =>
					Effect.promise(() =>
						db.pglite.query<{ updated_by: string }>(
							"SELECT updated_by FROM org_retention_policies WHERE org_id = $1",
							[ORG],
						),
					).pipe(Effect.map((rows) => Arr.map(rows.rows, (row) => row.updated_by)))
				const written = yield* retention.updateOrganization(ORG, BEN, (current) => ({ ...current }))
				assert.strictEqual(written.changed, false)
				assert.deepStrictEqual(written.policy.overrides, { traces: 60 })
				assert.deepStrictEqual(yield* updatedBy(), [ANA])
			}),
		),
	)

	it.effect("a write that sets nothing on an untouched organization leaves it unbounded", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const written = yield* retention.updateOrganization(ORG, ANA, () => ({}))
				assert.strictEqual(written.changed, false)
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), DEFAULT_READ_HORIZON)
			}),
		),
	)

	it.effect("records who last changed the organization's periods", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 60 })
				const rows = yield* Effect.promise(() =>
					db.pglite.query<{ updated_by: string }>(
						"SELECT updated_by FROM org_retention_policies WHERE org_id = $1",
						[ORG],
					),
				)
				assert.deepStrictEqual(
					Arr.map(rows.rows, (row) => row.updated_by),
					[ANA],
				)
			}),
		),
	)
})

describe("RetentionService.readHorizon", () => {
	it.effect("reads a stored period off the list as the gateway stamps it, without failing other orgs", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const elsewhere = yield* source(db, OTHER_ORG, "nodejs")
				yield* Effect.promise(() =>
					executeSql(
						db,
						`INSERT INTO org_retention_policies (org_id, retention_days, created_at, updated_at)
						 VALUES ($1, '{"traces": 45, "logs": 9000}'::jsonb, now(), now())`,
						[ORG],
					),
				)
				yield* Effect.promise(() =>
					executeSql(
						db,
						`UPDATE sources SET retention_days = '{"metrics": 400}'::jsonb WHERE id = $1`,
						[elsewhere],
					),
				)
				// 45 rounds up to 60; 9000 is past the longest period, so logs inherit.
				assert.deepStrictEqual((yield* retention.get(ORG)).overrides, { traces: 60 })
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), {
					days: { ...DEFAULT_RETENTION_DAYS, traces: 60 },
					configured: RETENTION_SIGNALS,
				})
				assert.deepStrictEqual(yield* retention.readHorizon(OTHER_ORG), {
					days: { ...DEFAULT_RETENTION_DAYS, metrics: 730 },
					configured: RETENTION_SIGNALS,
				})
			}),
		),
	)

	it.effect("an organization that set nothing reads the defaults, with no signal bounded", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), DEFAULT_READ_HORIZON)
			}),
		),
	)

	it.effect("bounds every signal once the organization or a source set any period", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setOrganization(ORG, ANA, { logs: 7 })
				yield* retention.setSource(ORG, ANA, debug, { traces: 90, profiles: 3 })
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), {
					// A source that keeps profiles for less does not pull the read in.
					days: { ...DEFAULT_RETENTION_DAYS, logs: 7, traces: 90 },
					configured: RETENTION_SIGNALS,
				})
				assert.deepStrictEqual(yield* retention.readHorizon(OTHER_ORG), DEFAULT_READ_HORIZON)
			}),
		),
	)

	it.effect("an organization period returned to the default still bounds reads at the default", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { logs: 90 })
				yield* retention.setOrganization(ORG, ANA, {})
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), {
					days: DEFAULT_RETENTION_DAYS,
					configured: RETENTION_SIGNALS,
				})
			}),
		),
	)

	it.effect("a source that inherits again leaves reads bounded at the organization's periods", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setSource(ORG, ANA, debug, { logs: 180 })
				yield* retention.setSource(ORG, ANA, debug, {})
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), {
					days: DEFAULT_RETENTION_DAYS,
					configured: RETENTION_SIGNALS,
				})
			}),
		),
	)

	it.effect("answers from its cache instead of reading the policy again", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const first = yield* retention.readHorizon(ORG)
				const reads = database.calls
				yield* TestClock.adjust(READ_HORIZON_TTL_MS - 1)
				assert.strictEqual(yield* retention.readHorizon(ORG), first)
				assert.strictEqual(database.calls, reads)
			}),
		),
	)

	it.effect("picks up a period set from elsewhere once the cached horizon has aged out", () =>
		withSwitchableDb((_database, db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.readHorizon(ORG)
				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(ORG, ANA, { traces: 7 })),
				)
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), DEFAULT_READ_HORIZON)
				yield* TestClock.adjust(READ_HORIZON_TTL_MS)
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), {
					days: { ...DEFAULT_RETENTION_DAYS, traces: 7 },
					configured: RETENTION_SIGNALS,
				})
			}),
		),
	)

	it.effect("reads a period set through this instance at once", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.readHorizon(ORG)
				yield* retention.setOrganization(ORG, ANA, { traces: 7 })
				const reads = database.calls
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).configured, RETENTION_SIGNALS)
				assert.strictEqual(database.calls, reads)
			}),
		),
	)

	it.effect("a write's slower read-back does not undo a write that landed beside it", () =>
		withSwitchableDb((database, db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const first = yield* source(db, ORG, "nodejs")
				const second = yield* source(db, ORG, "python")
				yield* retention.readHorizon(ORG)
				// Hold what the slow write reads back: the policy from before the other write.
				const parked = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const readBack = database.calls + 2
				database.afterCall = (call) =>
					call === readBack
						? Effect.andThen(Deferred.succeed(parked, undefined), Deferred.await(release))
						: Effect.void
				const slow = yield* Effect.forkChild(retention.setSource(ORG, ANA, second, { logs: 365 }))
				yield* Deferred.await(parked)
				yield* retention.setSource(ORG, ANA, first, { traces: 90 })
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(slow)
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).days, {
					...DEFAULT_RETENTION_DAYS,
					traces: 90,
					logs: 365,
				})
			}),
		),
	)

	it.effect("a write whose read-back fails does not publish its own older snapshot", () =>
		withSwitchableDb((database, db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const first = yield* source(db, ORG, "nodejs")
				const second = yield* source(db, ORG, "python")
				yield* retention.readHorizon(ORG)
				// Park the slow write between its commit and its read-back.
				const parked = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const commit = database.calls + 1
				database.afterCall = (call) =>
					call === commit
						? Effect.andThen(Deferred.succeed(parked, undefined), Deferred.await(release))
						: Effect.void
				const slow = yield* Effect.forkChild(retention.setSource(ORG, ANA, second, { logs: 365 }))
				yield* Deferred.await(parked)
				yield* retention.setSource(ORG, ANA, first, { traces: 90 })
				database.down = true
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(slow)
				database.down = false
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).days, {
					...DEFAULT_RETENTION_DAYS,
					traces: 90,
					logs: 365,
				})
			}),
		),
	)

	it.effect("after a write whose read-back fails, the next read loads the committed period", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				// The isolate holds a fresh copy from before the write.
				yield* retention.readHorizon(ORG)
				const commit = database.calls + 1
				database.afterCall = (call) =>
					Effect.sync(() => {
						if (call === commit) database.down = true
					})
				yield* retention.setOrganization(ORG, ANA, { traces: 7 })
				database.down = false
				assert.strictEqual((yield* retention.readHorizon(ORG)).days.traces, 7)
			}),
		),
	)

	it.effect("a write answers with what it committed when its read-back hangs", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				// The read-back gets its answer and never hands it over.
				const hanging = yield* Deferred.make<void>()
				const readBack = database.calls + 2
				database.afterCall = (call) =>
					call === readBack
						? Effect.andThen(Deferred.succeed(hanging, undefined), Effect.never)
						: Effect.void
				const write = yield* Effect.forkChild(retention.setOrganization(ORG, ANA, { traces: 7 }))
				yield* Deferred.await(hanging)
				yield* TestClock.adjust(READ_HORIZON_LOAD_TIMEOUT_MS)
				assert.strictEqual((yield* Fiber.join(write)).days.traces, 7)
			}),
		),
	)

	it.effect("serves the defaults when the policy cannot be read and none is known", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				database.down = true
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), DEFAULT_READ_HORIZON)
			}),
		),
	)

	it.effect("serves the last known horizon when the policy cannot be read, then recovers", () =>
		withSwitchableDb((database, db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.readHorizon(ORG)
				const known = yield* retention.setOrganization(ORG, ANA, { traces: 7 })
				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(ORG, ANA, { traces: 3 })),
				)
				database.down = true
				yield* TestClock.adjust(READ_HORIZON_TTL_MS)
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).days, known.readHorizonDays)

				// A failed read is not repeated on every call, and the next attempt is not a TTL away.
				const attempts = database.calls
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).days, known.readHorizonDays)
				assert.strictEqual(database.calls, attempts)
				database.down = false
				yield* TestClock.adjust(READ_HORIZON_RETRY_MS)
				assert.strictEqual((yield* retention.readHorizon(ORG)).days.traces, 3)
			}),
		),
	)

	/** Instances over one database and one shared cache, each as a new isolate would build it. */
	const isolates = () => {
		const db = createTestDb(trackedDbs)
		const database = makeSwitchableDatabase(db)
		const on = <A, E>(effect: Effect.Effect<A, E, RetentionService>) =>
			effect.pipe(
				Effect.provide(
					Layer.fresh(RetentionService.layer).pipe(
						Layer.provide(
							Layer.mergeAll(
								database.layer,
								testEdgeCache(db),
								Layer.fresh(TestReadHorizonMemoLive),
							),
						),
					),
				),
			)
		return { on, database: database.state }
	}
	const readHorizon = RetentionService.use((retention) => retention.readHorizon(ORG))

	it.effect("a fresh instance takes the horizon from the shared cache, without the policy read", () => {
		const { on, database } = isolates()
		return Effect.gen(function* () {
			yield* on(RetentionService.use((retention) => retention.setOrganization(ORG, ANA, { traces: 7 })))
			const first = yield* on(readHorizon)
			// With Postgres gone, only the shared cache can still answer 7.
			database.down = true
			const second = yield* on(readHorizon)
			assert.strictEqual(first.days.traces, 7)
			assert.deepStrictEqual(second, first)
		})
	})

	it.effect("a write drops the shared horizon, so the next fresh instance reads the new period", () => {
		const { on } = isolates()
		return Effect.gen(function* () {
			const before = yield* on(readHorizon)
			yield* on(RetentionService.use((retention) => retention.setOrganization(ORG, ANA, { traces: 7 })))
			const after = yield* on(readHorizon)
			assert.strictEqual(before.days.traces, DEFAULT_RETENTION_DAYS.traces)
			assert.strictEqual(after.days.traces, 7)
		})
	})

	it.effect("keeps a period it wrote when the policies cannot be read afterwards", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				// No read came before the write, so the isolate holds nothing else yet.
				yield* retention.setOrganization(ORG, ANA, { traces: 7 })
				database.down = true
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).configured, RETENTION_SIGNALS)
				assert.deepStrictEqual(yield* retention.readHorizon(OTHER_ORG), DEFAULT_READ_HORIZON)
			}),
		),
	)

	it.effect("keeps a period it wrote when a load returns an older snapshot", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 7 })
				// Another isolate's load, begun before the write, lands in the shared cache after it.
				yield* EdgeCacheService.use((edgeCache) =>
					edgeCache.getOrCompute(
						{
							bucket: READ_HORIZON_CACHE_BUCKET,
							key: READ_HORIZON_CACHE_KEY,
							ttlSeconds: 60,
							schema: Schema.Struct({
								readAtMs: Schema.Number,
								orgs: Schema.Array(Schema.Unknown),
							}),
						},
						Effect.succeed({ readAtMs: 0, orgs: [] }),
					),
				).pipe(Effect.provide(testEdgeCache(db)))
				// The read starts after the write, and still must not take the older snapshot over it.
				yield* TestClock.adjust(1)
				const horizon = yield* retention.readHorizon(ORG)
				assert.deepStrictEqual(horizon.configured, RETENTION_SIGNALS)
				assert.strictEqual(horizon.days.traces, 7)
			}),
		),
	)

	it.effect("a new service instance in the same isolate answers from what the isolate holds", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.readHorizon(ORG)
				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(ORG, ANA, { traces: 7 })),
				)
				// A cron lane builds the service again on every fire; a policy read would answer 7.
				const again = yield* RetentionService.use((next) => next.readHorizon(ORG)).pipe(
					Effect.provide(
						Layer.fresh(RetentionService.layer).pipe(
							Layer.provide(
								Layer.mergeAll(db.layer, testEdgeCache(db), TestReadHorizonMemoLive),
							),
						),
					),
				)
				assert.deepStrictEqual(again, DEFAULT_READ_HORIZON)
			}),
		),
	)

	// Live clock: readers that find a load under way look again after a real few milliseconds.
	it.live("readers arriving together on a new isolate share one policy read", () =>
		withSwitchableDb((database, db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const decodeOrgId = Schema.decodeSync(OrgId)
				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(ORG, ANA, { traces: 7 })),
				)
				// The first reader starts the load; the rest read the org that set a period, so a
				// reader that gave up on the load early would answer the default 30.
				const horizons = yield* Effect.forEach(
					[decodeOrgId("org_first"), ...Arr.makeBy(11, () => ORG)],
					(orgId) => retention.readHorizon(orgId),
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(database.calls, 1)
				assert.deepStrictEqual(
					Arr.map(horizons, (horizon) => horizon.days.traces),
					[DEFAULT_RETENTION_DAYS.traces, ...Arr.makeBy(11, () => 7)],
				)
			}),
		),
	)

	it.effect("reading many organizations costs one policy read, not one each", () =>
		withSwitchableDb((database, db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const decodeOrgId = Schema.decodeSync(OrgId)
				yield* fromAnotherIsolate(
					db,
					RetentionService.use((other) => other.setOrganization(OTHER_ORG, ANA, { logs: 7 })),
				)
				yield* retention.readHorizon(ORG)
				const horizons = yield* Effect.forEach(
					[ORG, OTHER_ORG, ...Arr.makeBy(20, (index) => decodeOrgId(`org_${index}`))],
					(orgId) => retention.readHorizon(orgId),
					{ concurrency: 5 },
				)
				assert.strictEqual(database.calls, 1)
				assert.deepStrictEqual(
					Arr.map(horizons, (horizon) => horizon.days.logs),
					[DEFAULT_RETENTION_DAYS.logs, 7, ...Arr.makeBy(20, () => DEFAULT_RETENTION_DAYS.logs)],
				)
			}),
		),
	)

	it.effect("a policy read that hangs gives way to the fallback instead of holding the read", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 7 })
				yield* retention.readHorizon(ORG)
				database.stalled = true
				yield* TestClock.adjust(READ_HORIZON_TTL_MS)
				const read = yield* Effect.forkChild(retention.readHorizon(ORG))
				yield* TestClock.adjust(READ_HORIZON_LOAD_TIMEOUT_MS)
				assert.strictEqual((yield* Fiber.join(read)).days.traces, 7)

				// The stalled database is left alone until the retry is due.
				const attempts = database.calls
				assert.strictEqual((yield* retention.readHorizon(ORG)).days.traces, 7)
				assert.strictEqual(database.calls, attempts)
			}),
		),
	)
})
