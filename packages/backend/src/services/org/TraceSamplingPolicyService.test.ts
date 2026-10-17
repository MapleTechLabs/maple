import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId, TraceSamplingPolicyUpdateRequest } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { TraceSamplingPolicyService } from "./TraceSamplingPolicyService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_sampling")

const makeLayer = (testDb: TestDb) => TraceSamplingPolicyService.layer.pipe(Layer.provide(testDb.layer))

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
})
