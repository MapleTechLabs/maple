import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId } from "@maple/domain/http"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { FirstDataSweepService } from "@maple/backend/services/org/FirstDataSweepService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { type SignalPresence, SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import {
	type ProductEventInput,
	ProductEventsService,
} from "@maple/backend/services/product-events/ProductEventsService"

const trackedDbs: TestDb[] = []
let emitted: Array<ProductEventInput> = []
afterEach(() => {
	emitted = []
	return cleanupTestDbs(trackedDbs)
})

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const DAY = 86_400_000
const LOGS_FIRST_SEEN = NOW - 3 * 3_600_000
const TRACES_FIRST_SEEN = NOW - 3_600_000

const org = Schema.decodeSync(OrgId)
const WITH_DATA = org("org_sweep_with_data")
const NO_DATA = org("org_sweep_no_data")
const OLD_WITH_DATA = org("org_sweep_old_with_data")
const STAMPED = org("org_sweep_stamped")

const present = (signal: SignalPresence["signal"], firstSeen: number): SignalPresence => ({
	signal,
	status: "present",
	count: 10,
	firstSeen,
	lastSeen: NOW,
})

/** Every org but NO_DATA has traces and logs; logs landed first. */
const signals = Layer.succeed(SignalPresenceService, {
	read: (tenant) =>
		Effect.succeed({
			generatedAt: NOW,
			windowStart: NOW - 30 * DAY,
			windowEnd: NOW,
			warehouseAvailable: true,
			signals:
				tenant.orgId === NO_DATA
					? []
					: [present("traces", TRACES_FIRST_SEEN), present("logs", LOGS_FIRST_SEEN)],
		}),
})

const makeLayer = (testDb: TestDb) =>
	Layer.effect(FirstDataSweepService, FirstDataSweepService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				signals,
				OnboardingService.layer.pipe(
					Layer.provide(
						Layer.succeed(ProductEventsService, {
							enabled: true,
							track: (event) => Effect.sync(() => void emitted.push(event)),
						}),
					),
				),
			),
		),
		Layer.provideMerge(testDb.layer),
	)

const seed = (testDb: TestDb, orgId: OrgId, createdAt: number, firstDataAt: number | null) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, demo_data_requested, first_data_received_at, created_at, updated_at)
			 VALUES ($1, false, $2, $3, $3)`,
			[orgId, firstDataAt === null ? null : new Date(firstDataAt), new Date(createdAt)],
		),
	)

const stampOf = (testDb: TestDb, orgId: OrgId) =>
	Effect.promise(() =>
		queryFirstRow<{ first_data_received_at: Date | null }>(
			testDb,
			"SELECT first_data_received_at FROM org_onboarding_state WHERE org_id = $1",
			[orgId],
		),
	).pipe(Effect.map((row) => row?.first_data_received_at?.getTime() ?? null))

describe("FirstDataSweepService", () => {
	it.effect("stamps recent orgs whose data landed and emits first_data_received once each", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* seed(testDb, WITH_DATA, NOW - 2 * DAY, null)
			yield* seed(testDb, NO_DATA, NOW - 2 * DAY, null)
			yield* seed(testDb, OLD_WITH_DATA, NOW - 45 * DAY, null)
			yield* seed(testDb, STAMPED, NOW - 2 * DAY, NOW - DAY)

			const sweep = yield* FirstDataSweepService
			const first = yield* sweep.runTick()
			assert.deepStrictEqual(first, { candidates: 2, stamped: 1, failures: 0 })
			assert.strictEqual(yield* stampOf(testDb, WITH_DATA), NOW)
			assert.isNull(yield* stampOf(testDb, NO_DATA))
			// Past the window: an abandoned signup is no longer probed.
			assert.isNull(yield* stampOf(testDb, OLD_WITH_DATA))

			// The stamped org drops out, so a second tick emits nothing new.
			const second = yield* sweep.runTick()
			assert.deepStrictEqual(second, { candidates: 1, stamped: 0, failures: 0 })

			assert.deepStrictEqual(
				Arr.map(emitted, (event) => ({
					name: event.name,
					groupId: event.groupId,
					timestamp: event.timestamp,
					attributes: event.attributes,
				})),
				[
					{
						name: "first_data_received",
						groupId: WITH_DATA,
						// Timed at the earliest row, not at the sweep.
						timestamp: LOGS_FIRST_SEEN,
						attributes: { signals: "logs,traces", first_signal: "logs" },
					},
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
