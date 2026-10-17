import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgIngestSamplingPolicies } from "@maple/db/tables"
import { OrgId, TraceSamplingPolicyUpdateRequest } from "@maple/domain/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { TraceSamplingPolicyService } from "./TraceSamplingPolicyService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_sampling")

const makeLayer = (testDb: TestDb) => TraceSamplingPolicyService.layer.pipe(Layer.provide(testDb.layer))

// In-memory PGlite settles in microtasks, so concurrent fibers never interleave between statements
// on their own. Yielding before each execute lets a racing update land between a read and a write.
const interleavingDatabase = (testDb: TestDb) =>
	Layer.effect(
		Database,
		Effect.map(Database, (database) =>
			Database.of({ execute: (fn) => Effect.yieldNow.pipe(Effect.andThen(database.execute(fn))) }),
		),
	).pipe(Layer.provide(testDb.layer))

// PGlite runs one transaction at a time, so a racing first insert is simulated: right after the
// update's first statement (the lock that finds no row), another writer's row lands.
const racingFirstInsertDatabase = (testDb: TestDb) =>
	Layer.effect(
		Database,
		Effect.gen(function* () {
			const database = yield* Database
			const raced = yield* Ref.make(false)
			return Database.of({
				execute: (fn) =>
					database.execute((db) =>
						fn({
							...db,
							run: (query, params) =>
								db.run(query, params).pipe(
									Effect.tap(() =>
										Ref.getAndSet(raced, true).pipe(
											Effect.flatMap((done) =>
												done
													? Effect.void
													: db.run(
															PG.insertInto(OrgIngestSamplingPolicies).values({
																orgId: ORG,
																createdAt: 1,
																updatedAt: 1,
																traceSampleRatio: 0.3,
																alwaysKeepErrorSpans: false,
																alwaysKeepSlowSpansMs: 900,
															}),
														),
											),
										),
									),
								),
						}),
					),
			})
		}),
	).pipe(Layer.provide(testDb.layer))

describe("TraceSamplingPolicyService", () => {
	it.effect("returns the gateway defaults for an org without a policy", () =>
		Effect.gen(function* () {
			const sampling = yield* TraceSamplingPolicyService
			const policy = yield* sampling.get(ORG)

			assert.strictEqual(policy.traceSampleRatio, 1)
			assert.isTrue(policy.alwaysKeepErrorSpans)
			assert.isNull(policy.alwaysKeepSlowSpansMs)
			assert.isNull(policy.updatedAt)
		}).pipe(Effect.provide(makeLayer(createTestDb(trackedDbs)))),
	)

	it.effect("creates the policy on first update and keeps omitted fields at their defaults", () =>
		Effect.gen(function* () {
			const sampling = yield* TraceSamplingPolicyService
			const { before, after } = yield* sampling.update(
				ORG,
				new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.25 }),
			)

			assert.strictEqual(before.traceSampleRatio, 1)
			assert.strictEqual(after.traceSampleRatio, 0.25)
			assert.isTrue(after.alwaysKeepErrorSpans)
			assert.isNull(after.alwaysKeepSlowSpansMs)
			assert.isNotNull(after.updatedAt)
			assert.deepStrictEqual(yield* sampling.get(ORG), after)
		}).pipe(Effect.provide(makeLayer(createTestDb(trackedDbs)))),
	)

	it.effect("patches only the given fields and clears the slow threshold with null", () =>
		Effect.gen(function* () {
			const sampling = yield* TraceSamplingPolicyService
			yield* sampling.update(
				ORG,
				new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.1, alwaysKeepSlowSpansMs: 2000 }),
			)
			const { before, after } = yield* sampling.update(
				ORG,
				new TraceSamplingPolicyUpdateRequest({
					alwaysKeepErrorSpans: false,
					alwaysKeepSlowSpansMs: null,
				}),
			)

			assert.strictEqual(before.alwaysKeepSlowSpansMs, 2000)
			assert.strictEqual(after.traceSampleRatio, 0.1)
			assert.isFalse(after.alwaysKeepErrorSpans)
			assert.isNull(after.alwaysKeepSlowSpansMs)
		}).pipe(Effect.provide(makeLayer(createTestDb(trackedDbs)))),
	)

	it.effect("keeps each org's policy separate", () =>
		Effect.gen(function* () {
			const sampling = yield* TraceSamplingPolicyService
			yield* sampling.update(ORG, new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.5 }))
			const other = yield* sampling.get(asOrgId("org_other"))

			assert.strictEqual(other.traceSampleRatio, 1)
			assert.isNull(other.updatedAt)
		}).pipe(Effect.provide(makeLayer(createTestDb(trackedDbs)))),
	)

	it.effect(
		"reads an out-of-range stored row the way the gateway applies it and lets it be repaired",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						"INSERT INTO org_ingest_sampling_policies (org_id, trace_sample_ratio, always_keep_error_spans, always_keep_slow_spans_ms) VALUES ($1, 0, true, -5)",
						[ORG],
					),
				)
				const sampling = yield* TraceSamplingPolicyService
				const policy = yield* sampling.get(ORG)

				assert.strictEqual(policy.traceSampleRatio, 0.000001)
				assert.isNull(policy.alwaysKeepSlowSpansMs)

				const { after } = yield* sampling.update(
					ORG,
					new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.5 }),
				)
				assert.strictEqual(after.traceSampleRatio, 0.5)
			}).pipe(Effect.provide(makeLayer(testDb)))
		},
	)

	it.effect("audits the other writer's values when a first insert loses the race", () =>
		Effect.gen(function* () {
			const sampling = yield* TraceSamplingPolicyService
			const { before, after } = yield* sampling.update(
				ORG,
				new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.6 }),
			)

			assert.strictEqual(before.traceSampleRatio, 0.3)
			assert.isFalse(before.alwaysKeepErrorSpans)
			assert.strictEqual(before.alwaysKeepSlowSpansMs, 900)
			assert.strictEqual(after.traceSampleRatio, 0.6)
			assert.isFalse(after.alwaysKeepErrorSpans)
			assert.strictEqual(after.alwaysKeepSlowSpansMs, 900)
		}).pipe(
			Effect.provide(
				TraceSamplingPolicyService.layer.pipe(
					Layer.provide(racingFirstInsertDatabase(createTestDb(trackedDbs))),
				),
			),
		),
	)

	it.effect("keeps both of two concurrent updates to disjoint fields", () =>
		Effect.gen(function* () {
			const sampling = yield* TraceSamplingPolicyService
			yield* sampling.update(ORG, new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.5 }))
			yield* Effect.all(
				[
					sampling.update(ORG, new TraceSamplingPolicyUpdateRequest({ traceSampleRatio: 0.2 })),
					sampling.update(
						ORG,
						new TraceSamplingPolicyUpdateRequest({ alwaysKeepSlowSpansMs: 1500 }),
					),
					sampling.update(
						ORG,
						new TraceSamplingPolicyUpdateRequest({ alwaysKeepErrorSpans: false }),
					),
				],
				{ concurrency: "unbounded" },
			)
			const policy = yield* sampling.get(ORG)

			assert.strictEqual(policy.traceSampleRatio, 0.2)
			assert.strictEqual(policy.alwaysKeepSlowSpansMs, 1500)
			assert.isFalse(policy.alwaysKeepErrorSpans)
		}).pipe(
			Effect.provide(
				TraceSamplingPolicyService.layer.pipe(
					Layer.provide(interleavingDatabase(createTestDb(trackedDbs))),
				),
			),
		),
	)
})
