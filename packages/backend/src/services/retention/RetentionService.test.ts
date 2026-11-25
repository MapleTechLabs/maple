import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, SourceId, UserId } from "@maple/domain/http"
import { DEFAULT_RETENTION_DAYS } from "@maple/domain/retention"
import {
	cleanupTestDbs,
	createTestDb,
	insertTestSource,
	makeSwitchableDatabase,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import {
	DEFAULT_READ_HORIZON,
	READ_HORIZON_CACHE_MAX_ENTRIES,
	READ_HORIZON_RETRY_MS,
	READ_HORIZON_TTL_MS,
	RetentionService,
} from "./RetentionService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_retention")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_elsewhere")
const ANA = Schema.decodeSync(UserId)("user_ana")
const decodeSourceId = Schema.decodeSync(SourceId)

const withDb = <A, E>(run: (db: TestDb) => Effect.Effect<A, E, RetentionService>) => {
	const db = createTestDb(trackedDbs)
	return run(db).pipe(Effect.provide(RetentionService.layer.pipe(Layer.provide(db.layer))))
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
		Effect.provide(RetentionService.layer.pipe(Layer.provide(database.layer))),
	)
}

/** A write from elsewhere: another instance over the same database, as another isolate is. */
const fromAnotherIsolate = <A, E>(db: TestDb, effect: Effect.Effect<A, E, RetentionService>) =>
	effect.pipe(Effect.provide(Layer.fresh(RetentionService.layer).pipe(Layer.provide(db.layer))))

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
				const policy = yield* retention.setOrganization(ORG, ANA, { traces: 45, logs: 7 })
				assert.deepStrictEqual(policy.days, { ...DEFAULT_RETENTION_DAYS, traces: 45, logs: 7 })
				assert.deepStrictEqual(policy.readHorizonDays, policy.days)
				assert.deepStrictEqual(yield* retention.get(ORG), policy)
			}),
		),
	)

	it.effect("setting again replaces the earlier periods instead of merging into them", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 45, logs: 7 })
				const policy = yield* retention.setOrganization(ORG, ANA, { metrics: 400 })
				assert.deepStrictEqual(policy.overrides, { metrics: 400 })
				assert.deepStrictEqual(policy.days, { ...DEFAULT_RETENTION_DAYS, metrics: 400 })
			}),
		),
	)

	it.effect("a source keeps its own period for the signals it sets and inherits the rest", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* source(db, ORG, "python")
				yield* retention.setOrganization(ORG, ANA, { traces: 45 })
				const policy = yield* retention.setSource(ORG, ANA, debug, { traces: 3, logs: 90 })
				assert.deepStrictEqual(policy.sources, [
					{
						sourceId: debug,
						overrides: { traces: 3, logs: 90 },
						days: { ...DEFAULT_RETENTION_DAYS, traces: 3, logs: 90 },
					},
				])
				// The organization's own periods are unchanged by one source.
				assert.deepStrictEqual(policy.days, { ...DEFAULT_RETENTION_DAYS, traces: 45 })
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
				const policy = yield* retention.setSource(ORG, ANA, long, { logs: 400 })
				assert.strictEqual(policy.readHorizonDays.traces, DEFAULT_RETENTION_DAYS.traces)
				assert.strictEqual(policy.readHorizonDays.logs, 400)
			}),
		),
	)

	it.effect("clearing a source's periods makes it inherit again", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setSource(ORG, ANA, debug, { logs: 400 })
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
				yield* retention.setSource(OTHER_ORG, ANA, theirs, { traces: 400 })
				yield* retention.setOrganization(OTHER_ORG, ANA, { logs: 400 })

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
				assert.deepStrictEqual(stored?.retention_days, { traces: 400 })
			}),
		),
	)

	it.effect("refuses a period that cannot be stored, as a bad request and without writing", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setOrganization(ORG, ANA, { logs: 800 })
				const tooLong = yield* Effect.result(retention.setOrganization(ORG, ANA, { logs: 801 }))
				const fraction = yield* Effect.result(retention.setSource(ORG, ANA, debug, { traces: 1.5 }))
				for (const refused of [tooLong, fraction]) {
					assert.isTrue(Result.isFailure(refused))
					if (Result.isFailure(refused)) {
						assert.strictEqual(
							refused.failure._tag,
							"@maple/http/retention/RetentionInvalidError",
						)
					}
				}
				const policy = yield* retention.get(ORG)
				assert.deepStrictEqual(policy.overrides, { logs: 800 })
				assert.deepStrictEqual(policy.sources, [])
			}),
		),
	)

	it.effect("records who last changed the organization's periods", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				yield* retention.setOrganization(ORG, ANA, { traces: 45 })
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
	it.effect("an organization that set nothing reads the defaults, with no signal bounded", () =>
		withDb(() =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), DEFAULT_READ_HORIZON)
			}),
		),
	)

	it.effect("names the signals the organization or one of its sources set, and no others", () =>
		withDb((db) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const debug = yield* source(db, ORG, "nodejs")
				yield* retention.setOrganization(ORG, ANA, { logs: 7 })
				yield* retention.setSource(ORG, ANA, debug, { traces: 90, profiles: 3 })
				assert.deepStrictEqual(yield* retention.readHorizon(ORG), {
					// A source that keeps profiles for less does not pull the read in.
					days: { ...DEFAULT_RETENTION_DAYS, logs: 7, traces: 90 },
					configured: ["traces", "logs", "profiles"],
				})
				assert.deepStrictEqual(yield* retention.readHorizon(OTHER_ORG), DEFAULT_READ_HORIZON)
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
					configured: ["traces"],
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
				assert.deepStrictEqual((yield* retention.readHorizon(ORG)).configured, ["traces"])
				assert.strictEqual(database.calls, reads)
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

	it.effect("forgets the organization read longest ago once the cache is full", () =>
		withSwitchableDb((database) =>
			Effect.gen(function* () {
				const retention = yield* RetentionService
				const decodeOrgId = Schema.decodeSync(OrgId)
				// Unreadable policies are cached like any other and cost no query to fill with.
				database.down = true
				yield* retention.readHorizon(ORG)
				yield* retention.readHorizon(OTHER_ORG)
				yield* Effect.forEach(
					Arr.makeBy(READ_HORIZON_CACHE_MAX_ENTRIES - 2, (index) => decodeOrgId(`org_${index}`)),
					(orgId) => retention.readHorizon(orgId),
					{ discard: true },
				)
				// Reading ORG again makes OTHER_ORG the oldest, so one more organization evicts it.
				yield* retention.readHorizon(ORG)
				yield* retention.readHorizon(decodeOrgId("org_one_more"))
				const attempts = database.calls
				yield* retention.readHorizon(ORG)
				assert.strictEqual(database.calls, attempts)
				yield* retention.readHorizon(OTHER_ORG)
				assert.isAbove(database.calls, attempts)
			}),
		),
	)
})
