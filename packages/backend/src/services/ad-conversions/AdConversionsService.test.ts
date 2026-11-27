import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { ProductEventsService } from "@maple/backend/services/product-events/ProductEventsService"
import { AdConversionsService } from "./AdConversionsService"
import type { AdClick } from "./ad-click"
import { buildGoogleAdsConversionsCsv } from "./google-ads-csv"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const DAY = 86_400_000
const NOW = 1_764_000_000_000
const ADA = Schema.decodeSync(UserId)("user_ada")
const BOB = Schema.decodeSync(UserId)("user_bob")
const CAL = Schema.decodeSync(UserId)("user_cal")
const ORG = Schema.decodeSync(OrgId)("org_ada")

const layerFor = (testDb: TestDb) =>
	Layer.mergeAll(AdConversionsService.layer, OnboardingService.layer).pipe(
		Layer.provideMerge(Layer.mergeAll(testDb.layer, ProductEventsService.noop)),
	)

const csvAt = (nowMs: number) =>
	Effect.gen(function* () {
		const ads = yield* AdConversionsService
		return buildGoogleAdsConversionsCsv(yield* ads.listForExport(nowMs))
	})

describe("AdConversionsService", () => {
	it.effect("counts a retried sign-up once and activates only a user with an ad sign-up", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const ads = yield* AdConversionsService
			const click: AdClick = { type: "gclid", id: "Cj0K_ada", clickTime: NOW - DAY }
			yield* ads.recordSignup(ADA, click, NOW)
			yield* ads.recordSignup(ADA, { ...click, id: "Cj0K_retry" }, NOW + 1000)

			assert.isTrue(yield* ads.recordActivation(ADA, NOW + DAY))
			assert.isFalse(yield* ads.recordActivation(ADA, NOW + 2 * DAY))
			assert.isFalse(yield* ads.recordActivation(BOB, NOW + DAY))

			assert.strictEqual(
				yield* csvAt(NOW + 2 * DAY),
				Arr.join(
					[
						"Parameters:TimeZone=+0000",
						"Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency",
						"Cj0K_ada,Sign-up (server),2025-11-24 16:00:00+0000,,",
						"Cj0K_ada,Activated (server),2025-11-25 16:00:00+0000,,",
						"",
					],
					"\n",
				),
			)
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("leaves out clicks past Google's 90 days and the click types a file cannot take", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const ads = yield* AdConversionsService
			yield* ads.recordSignup(ADA, { type: "gclid", id: "old", clickTime: NOW - DAY }, NOW)
			yield* ads.recordSignup(BOB, { type: "wbraid", id: "ios", clickTime: NOW }, NOW)
			yield* ads.recordSignup(CAL, { type: "gclid", id: "edge", clickTime: NOW }, NOW)
			const csv = yield* csvAt(NOW + 90 * DAY)
			assert.notInclude(csv, "old")
			assert.notInclude(csv, "ios")
			// A click exactly 90 days old is still inside Google's window.
			assert.include(csv, "edge,Sign-up (server),")
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("records the org creator's activation when the org first receives data", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const ads = yield* AdConversionsService
			yield* ads.recordSignup(ADA, { type: "gclid", id: "Cj0K_ada", clickTime: NOW - DAY }, NOW - DAY)
			const onboarding = yield* OnboardingService
			yield* onboarding.ensureRow(ORG, ADA, undefined, { createdAt: NOW - DAY })
			const firstData = { signals: ["traces"], firstSeenMs: null, windowStartMs: NOW - DAY }
			assert.isTrue(
				yield* onboarding.recordFirstDataReceived(ORG, Effect.succeed(NOW - DAY), firstData, null),
			)
			assert.include(yield* csvAt(NOW), "Cj0K_ada,Activated (server),2025-11-24 16:00:00+0000,,")
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect(
		"forgets a deleted user's clicks, even when the sign-up is delivered after the deletion",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const ads = yield* AdConversionsService
				yield* ads.recordSignup(ADA, { type: "gclid", id: "Cj0K_ada", clickTime: NOW }, NOW)
				yield* ads.forgetUser(ADA)
				assert.notInclude(yield* csvAt(NOW), "Cj0K_ada")
				yield* ads.forgetUser(BOB)
				yield* ads.recordSignup(BOB, { type: "gclid", id: "Cj0K_bob", clickTime: NOW }, NOW)
				assert.isFalse(yield* ads.recordActivation(BOB, NOW + DAY))
				assert.notInclude(yield* csvAt(NOW + DAY), "Cj0K_bob")
			}).pipe(Effect.provide(layerFor(testDb)))
		},
	)
})
