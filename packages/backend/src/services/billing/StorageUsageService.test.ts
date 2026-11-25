import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Order, Schema } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { OrgId } from "@maple/domain/http"
import { DATA_RATES, type StorageSignalUsage } from "@maple/domain/storage-pricing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { meterStorage, runStorageMetering } from "./storage-metering"
import { DAY_MS, StorageUsageService } from "./StorageUsageService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_storage")
const GB = 1_000_000_000
// 2026-11-25T00:00:00Z: a 30-day month.
const TODAY = Date.UTC(2026, 10, 25)

const ledger = (
	db: TestDb,
	orgId: string,
	signal: string,
	daysAgo: number,
	retentionDays: number,
	gb: number,
) =>
	Effect.promise(() =>
		executeSql(
			db,
			`INSERT INTO ingest_storage_ledger (org_id, signal, day, retention_days, bytes)
			 VALUES ($1, $2, to_timestamp($3::float8 / 1000), $4, $5)`,
			[orgId, signal, TODAY - daysAgo * DAY_MS, retentionDays, gb * GB],
		),
	)

const usageOf = (signals: ReadonlyArray<StorageSignalUsage>, signal: string) =>
	Option.getOrUndefined(Arr.findFirst(signals, (usage) => usage.signal === signal))

const summaryAt = (db: TestDb, nowMs: number) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(nowMs)
		const service = yield* StorageUsageService
		return yield* service.summary(ORG)
	}).pipe(Effect.provide(StorageUsageService.layer.pipe(Layer.provide(db.layer))))

describe("StorageUsageService.summary", () => {
	it.effect("counts each day only while its own period keeps it", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 0, 30, 1)
			yield* ledger(db, ORG, "logs", 29, 30, 2)
			// Past its 30 days: deleted by storage, so no longer billed.
			yield* ledger(db, ORG, "logs", 30, 30, 4)
			// The same day under a longer period is still kept.
			yield* ledger(db, ORG, "logs", 30, 90, 8)
			yield* ledger(db, "org_elsewhere", "logs", 0, 30, 16)

			const summary = yield* summaryAt(db, TODAY + 3_600_000)
			assert.strictEqual(usageOf(summary.signals, "logs")?.storedGb, 11)
			assert.deepStrictEqual(summary.rates, DATA_RATES)
			assert.deepStrictEqual(
				Arr.map(summary.signals, (usage) => usage.signal),
				["traces", "logs", "metrics", "profiles"],
			)
		}),
	)

	it.effect("averages the last 7 complete UTC days, leaving out today", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "traces", 0, 30, 100)
			yield* ledger(db, ORG, "traces", 1, 30, 7)
			yield* ledger(db, ORG, "traces", 1, 90, 7)
			yield* ledger(db, ORG, "traces", 7, 30, 14)
			yield* ledger(db, ORG, "traces", 8, 30, 1000)

			const summary = yield* summaryAt(db, TODAY + 3_600_000)
			assert.strictEqual(usageOf(summary.signals, "traces")?.avgDailyGb, 4)
			assert.deepStrictEqual(usageOf(summary.signals, "metrics"), {
				signal: "metrics",
				storedGb: 0,
				avgDailyGb: 0,
			})
		}),
	)
})

interface Tracked {
	readonly idempotencyKey: string | undefined
	readonly body: { readonly customer_id: string; readonly feature_id: string; readonly value: number }
}

const recordingAutumn = (tracked: Array<Tracked>) =>
	Layer.mergeAll(
		ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTUMN_SECRET_KEY: "am_sk_test" })),
		Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
				Effect.sync(() => {
					const text =
						request.body._tag === "Uint8Array"
							? new TextDecoder().decode(request.body.body)
							: "{}"
					tracked.push({
						idempotencyKey: request.headers["idempotency-key"],
						body: JSON.parse(text),
					})
					return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
				}),
			),
		),
	)

describe("storage metering", () => {
	it.effect("bills each org a day's share of its GB stored, to its billing org, once per day", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 2, 30, 200)
			yield* ledger(db, ORG, "metrics", 40, 90, 100)
			yield* ledger(db, ORG, "logs", 31, 30, 999)
			yield* ledger(db, "org_member", "traces", 0, 30, 30)
			yield* Effect.promise(() =>
				executeSql(
					db,
					`INSERT INTO org_billing_links (org_id, billing_org_id, linked_by, created_at)
					 VALUES ('org_member', 'org_payer', 'user_a', now())`,
				),
			)
			const tracked: Array<Tracked> = []
			const meter = (nowMs: number) =>
				meterStorage(nowMs).pipe(Effect.provide([db.layer, recordingAutumn(tracked)]))

			yield* meter(TODAY + 60_000)
			const byCustomer = new Map(
				Arr.map(tracked, (call): [string, Tracked] => [call.body.customer_id, call]),
			)
			// 300 GB stored over a 30-day month: 10 GB-months a day.
			assert.strictEqual(byCustomer.get("org_storage")?.body.value, 10)
			assert.strictEqual(
				byCustomer.get("org_storage")?.idempotencyKey,
				"storage:org_storage:2026-11-25",
			)
			assert.strictEqual(byCustomer.get("org_payer")?.body.value, 1)
			assert.strictEqual(byCustomer.get("org_payer")?.idempotencyKey, "storage:org_member:2026-11-25")
			assert.strictEqual(byCustomer.get("org_payer")?.body.feature_id, "storage")

			// A retry the same day reuses the day's key, so Autumn counts it once.
			yield* meter(TODAY + 2 * 3_600_000)
			const keys = (calls: ReadonlyArray<Tracked>) =>
				Arr.sort(
					Arr.map(calls, (call) => call.idempotencyKey ?? ""),
					Order.String,
				)
			assert.deepStrictEqual(keys(tracked.slice(2)), keys(tracked.slice(0, 2)))
		}),
	)

	it.effect("prunes days past the longest period and bills only early in the UTC day", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "events", 732, 730, 5)
			yield* ledger(db, ORG, "logs", 729, 730, 5)
			const tracked: Array<Tracked> = []
			const provideAll = Effect.provide([db.layer, recordingAutumn(tracked)])

			const result = yield* meterStorage(TODAY).pipe(provideAll)
			assert.strictEqual(result.pruned, 1)
			assert.strictEqual(tracked.length, 1)

			yield* TestClock.setTime(TODAY + 5 * 3_600_000)
			yield* runStorageMetering.pipe(provideAll)
			assert.strictEqual(tracked.length, 1)
		}),
	)
})
