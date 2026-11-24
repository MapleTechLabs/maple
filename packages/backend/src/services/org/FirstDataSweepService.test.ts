import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Order, Schema } from "effect"
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
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
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
/** Sent data from Quick Start before anything wrote its onboarding row. */
const KEY_ONLY = org("org_sweep_key_only")
/** Only ever clicked Quick Start's "Send test trace": the warehouse has that one trace. */
const TEST_TRACE_ONLY = org("org_sweep_test_trace_only")
const KEY_ONLY_CREATED_AT = NOW - 2 * 3_600_000

const present = (signal: SignalPresence["signal"], firstSeen: number): SignalPresence => ({
	signal,
	status: "present",
	count: 10,
	firstSeen,
	lastSeen: NOW,
})

/** Every org but NO_DATA has traces and logs; logs landed first. TEST_TRACE_ONLY has its test trace. */
const signals = Layer.succeed(SignalPresenceService, {
	read: (tenant, options) =>
		Effect.succeed({
			generatedAt: NOW,
			windowStart: NOW - 30 * DAY,
			windowEnd: NOW,
			warehouseAvailable: true,
			signals:
				tenant.orgId === NO_DATA
					? []
					: tenant.orgId === TEST_TRACE_ONLY
						? options?.excludeTestTrace === true
							? []
							: [present("traces", TRACES_FIRST_SEEN)]
						: [present("traces", TRACES_FIRST_SEEN), present("logs", LOGS_FIRST_SEEN)],
		}),
})

const makeLayer = (testDb: TestDb) =>
	Layer.effect(FirstDataSweepService, FirstDataSweepService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				signals,
				Layer.succeed(OrganizationService, {
					create: () => Effect.die("create is not used by the first-data sweep"),
					chooseRegion: () => Effect.die("chooseRegion is not used by the first-data sweep"),
					retrieve: (orgId) =>
						Effect.succeed({
							id: orgId,
							name: null,
							slug: null,
							imageUrl: null,
							createdAtMs: orgId === KEY_ONLY ? KEY_ONLY_CREATED_AT : NOW - 2 * DAY,
						}),
				}),
				OnboardingService.layer.pipe(
					Layer.provide(
						Layer.succeed(ProductEventsService, {
							enabled: true,
							track: (event) => Effect.sync(() => void emitted.push(event)),
							trackAll: (events) => Effect.sync(() => void emitted.push(...events)),
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
			`INSERT INTO org_onboarding_state (org_id, user_id, demo_data_requested, first_data_received_at, created_at, updated_at)
			 VALUES ($1, $2, false, $3, $4, $4)`,
			[
				orgId,
				`user_of_${orgId}`,
				firstDataAt === null ? null : new Date(firstDataAt),
				new Date(createdAt),
			],
		),
	)

const seedIngestKey = (testDb: TestDb, orgId: OrgId, createdAt: number) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_ingest_keys (org_id, public_key, public_key_hash, private_key_ciphertext, private_key_iv,
			   private_key_tag, private_key_hash, public_rotated_at, private_rotated_at, created_at, updated_at,
			   created_by, updated_by)
			 VALUES ($1, $1 || '_pub', $1 || '_pubh', 'c', 'iv', 'tag', $1 || '_privh', $2, $2, $2, $2, 'user_key_maker', 'user_key_maker')`,
			[orgId, new Date(createdAt)],
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
			yield* seedIngestKey(testDb, STAMPED, NOW - 2 * DAY)
			yield* seedIngestKey(testDb, KEY_ONLY, KEY_ONLY_CREATED_AT)

			const sweep = yield* FirstDataSweepService
			const first = yield* sweep.runTick()
			assert.deepStrictEqual(first, { candidates: 3, stamped: 2, failures: 0 })
			assert.strictEqual(yield* stampOf(testDb, WITH_DATA), NOW)
			assert.strictEqual(yield* stampOf(testDb, KEY_ONLY), NOW)
			assert.isNull(yield* stampOf(testDb, NO_DATA))
			// Past the window: an abandoned signup is no longer probed.
			assert.isNull(yield* stampOf(testDb, OLD_WITH_DATA))

			// The stamped org drops out, so a second tick emits nothing new.
			const second = yield* sweep.runTick()
			assert.deepStrictEqual(second, { candidates: 1, stamped: 0, failures: 0 })

			assert.deepStrictEqual(
				// Probes run concurrently, so compare in org order.
				Arr.map(
					Arr.sortWith(emitted, (event) => event.groupId ?? "", Order.String),
					(event) => ({
						name: event.name,
						groupId: event.groupId,
						userId: event.userId,
						timestamp: event.timestamp,
						attributes: event.attributes,
					}),
				),
				[
					{
						name: "first_data_received",
						groupId: KEY_ONLY,
						// Who created the ingest key, since no onboarding row names anyone.
						userId: "user_key_maker",
						// The hour-floored first row predates the org, so it is lifted to its creation.
						timestamp: KEY_ONLY_CREATED_AT,
						attributes: { signals: "logs,traces", first_signal: "logs" },
					},
					{
						name: "first_data_received",
						groupId: WITH_DATA,
						userId: `user_of_${WITH_DATA}`,
						// Timed at the earliest row, not at the sweep.
						timestamp: LOGS_FIRST_SEEN,
						attributes: { signals: "logs,traces", first_signal: "logs" },
					},
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("does not count onboarding's test trace as an org's first data", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* seed(testDb, TEST_TRACE_ONLY, NOW - 2 * DAY, null)

			const sweep = yield* FirstDataSweepService
			assert.deepStrictEqual(yield* sweep.runTick(), { candidates: 1, stamped: 0, failures: 0 })
			assert.isNull(yield* stampOf(testDb, TEST_TRACE_ONLY))
			assert.deepStrictEqual(emitted, [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
