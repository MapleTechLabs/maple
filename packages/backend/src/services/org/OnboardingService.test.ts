import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId } from "@maple/domain/http"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_reward_lease")
const LEASE_MS = 60_000

const layerFor = (testDb: TestDb) => OnboardingService.layer.pipe(Layer.provideMerge(testDb.layer))

const seedRow = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, demo_data_requested, created_at, updated_at)
			 VALUES ($1, false, now(), now())`,
			[ORG],
		),
	)

const rewardState = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ reward_reserved_at: Date | null; reward_claimed_at: Date | null }>(
			testDb,
			"SELECT reward_reserved_at, reward_claimed_at FROM org_onboarding_state WHERE org_id = $1",
			[ORG],
		),
	)

/** Holder A's lease lapses and holder B takes it over; returns both reservations. */
const lapseAndTakeOver = Effect.gen(function* () {
	const onboarding = yield* OnboardingService
	const first = yield* onboarding.reserveRewardClaim(ORG, LEASE_MS)
	yield* TestClock.adjust(`${LEASE_MS + 1} millis`)
	const second = yield* onboarding.reserveRewardClaim(ORG, LEASE_MS)
	return { first: Option.getOrThrow(first), second: Option.getOrThrow(second) }
})

describe("OnboardingService reward lease", () => {
	it.effect("a holder whose lease lapsed cannot release the next holder's reservation", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedRow(testDb)
			const { first, second } = yield* lapseAndTakeOver
			yield* (yield* OnboardingService).releaseRewardClaim(ORG, first)

			const row = yield* rewardState(testDb)
			assert.strictEqual(row?.reward_reserved_at?.getTime(), second)
			// The live reservation still blocks a third claimant.
			assert.isTrue(Option.isNone(yield* (yield* OnboardingService).reserveRewardClaim(ORG, LEASE_MS)))
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("a holder whose lease lapsed records its claim but keeps the next holder's lease", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedRow(testDb)
			const { first, second } = yield* lapseAndTakeOver
			yield* (yield* OnboardingService).finalizeRewardClaim(ORG, first)

			const row = yield* rewardState(testDb)
			assert.strictEqual(row?.reward_reserved_at?.getTime(), second)
			assert.isNotNull(row?.reward_claimed_at)
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("the current holder finalizes and releases its own lease", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedRow(testDb)
			const onboarding = yield* OnboardingService
			const held = Option.getOrThrow(yield* onboarding.reserveRewardClaim(ORG, LEASE_MS))
			yield* onboarding.finalizeRewardClaim(ORG, held)

			const row = yield* rewardState(testDb)
			assert.strictEqual(row?.reward_reserved_at, null)
			assert.strictEqual(row?.reward_claimed_at?.getTime(), held)
		}).pipe(Effect.provide(layerFor(testDb)))
	})
})
