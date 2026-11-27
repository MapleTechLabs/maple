import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Order, Schema, String as Str } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { OrgId } from "@maple/domain/http"
import { DATA_RATES, type StorageSignalUsage } from "@maple/domain/storage-pricing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { BACKFILL_DAYS, meterStorage, runStorageMetering, SETTLE_MS } from "./storage-metering"
import { DAY_MS, StorageUsageService } from "./StorageUsageService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_storage")
const GB = 1_000_000_000
// 2026-11-25T00:00:00Z: a 30-day month.
const TODAY = Date.UTC(2026, 10, 25)
// The first tick that bills yesterday.
const SETTLED = TODAY + SETTLE_MS + 60_000

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
			assert.deepStrictEqual(summary.rates, { storagePerGbMonth: DATA_RATES.storagePerGbMonth })
			// Profiles ingest is priced above the other signals.
			assert.strictEqual(usageOf(summary.signals, "logs")?.ingestPerGb, 0.15)
			assert.strictEqual(usageOf(summary.signals, "profiles")?.ingestPerGb, 0.6)
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
				ingestPerGb: 0.15,
			})
		}),
	)
})

interface Tracked {
	readonly idempotencyKey: string | undefined
	readonly body: { readonly customer_id: string; readonly feature_id: string; readonly value: number }
}

/** An Autumn that records every call and answers `status(call)` to it. */
const recordingAutumn = (
	tracked: Array<Tracked>,
	status: (call: Tracked) => number = () => 200,
	env: Record<string, unknown> = { AUTUMN_SECRET_KEY: "am_sk_test" },
) =>
	Layer.mergeAll(
		ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
		Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
				Effect.sync(() => {
					const text =
						request.body._tag === "Uint8Array"
							? new TextDecoder().decode(request.body.body)
							: "{}"
					const call: Tracked = {
						idempotencyKey: request.headers["idempotency-key"],
						body: JSON.parse(text),
					}
					tracked.push(call)
					return HttpClientResponse.fromWeb(request, new Response(null, { status: status(call) }))
				}),
			),
		),
	)

const keysOf = (calls: ReadonlyArray<Tracked>) =>
	Arr.sort(
		Arr.map(calls, (call) => call.idempotencyKey ?? ""),
		Order.String,
	)

describe("storage metering", () => {
	it.effect("bills each org yesterday's share of its GB stored, to its billing org, once", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 2, 30, 200)
			yield* ledger(db, ORG, "metrics", 40, 90, 100)
			yield* ledger(db, ORG, "logs", 31, 30, 999)
			// Today is not complete: bytes received today never count toward yesterday.
			yield* ledger(db, ORG, "logs", 0, 30, 5000)
			yield* ledger(db, "org_member", "traces", 1, 30, 30)
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

			// The day just ended waits for the gateway's last flush.
			yield* meter(TODAY + 30 * 60_000)
			assert.isFalse(Arr.some(tracked, (call) => Str.endsWith("2026-11-24")(call.idempotencyKey ?? "")))

			yield* meter(SETTLED)
			const yesterday = new Map(
				Arr.flatMap(tracked, (call): ReadonlyArray<[string, Tracked]> =>
					Str.endsWith("2026-11-24")(call.idempotencyKey ?? "")
						? [[call.idempotencyKey ?? "", call]]
						: [],
				),
			)
			// Each signal goes to its own storage feature, where Autumn applies its allowance.
			// 200 GB of logs and 100 GB of metrics stored on 2026-11-24, a day of a 30-day month.
			const logs = yesterday.get("storage:org_storage:logs:2026-11-24")
			const metrics = yesterday.get("storage:org_storage:metrics:2026-11-24")
			assert.strictEqual(logs?.body.feature_id, "storage_logs")
			assert.closeTo(logs?.body.value ?? 0, 200 / 30, 1e-9)
			assert.strictEqual(metrics?.body.feature_id, "storage_metrics")
			assert.closeTo(metrics?.body.value ?? 0, 100 / 30, 1e-9)
			// Before any allowance, at $0.15 per GB-month, that day's 10 GB-months cost $1.50.
			assert.closeTo(
				((logs?.body.value ?? 0) + (metrics?.body.value ?? 0)) * DATA_RATES.storagePerGbMonth,
				1.5,
				1e-9,
			)
			const member = yesterday.get("storage:org_member:traces:2026-11-24")
			assert.strictEqual(member?.body.customer_id, "org_payer")
			assert.strictEqual(member?.body.feature_id, "storage_traces")
			assert.strictEqual(member?.body.value, 1)
			assert.isFalse(Arr.some(tracked, (call) => Str.endsWith("2026-11-25")(call.idempotencyKey ?? "")))

			// A later tick finds every day billed and sends nothing.
			const sent = tracked.length
			yield* meter(TODAY + 2 * 3_600_000)
			assert.strictEqual(tracked.length, sent)
		}),
	)

	it.effect("bills a day Autumn refused again on the next tick, under the same key", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 3, 30, 30)
			const tracked: Array<Tracked> = []
			let autumnUp = false
			const autumn = recordingAutumn(tracked, () => (autumnUp ? 200 : 503))

			yield* TestClock.setTime(SETTLED)
			const failed = yield* runStorageMetering.pipe(Effect.provide([db.layer, autumn]), Effect.flip)
			assert.strictEqual(failed._tag, "@maple/billing/StorageMeteringIncompleteError")
			const refused = keysOf(tracked)

			autumnUp = true
			yield* TestClock.setTime(TODAY + 3_600_000)
			yield* runStorageMetering.pipe(Effect.provide([db.layer, autumn]))
			assert.deepStrictEqual(keysOf(tracked.slice(refused.length)), refused)
			// Oldest first, from the ingest day through yesterday.
			assert.deepStrictEqual(refused, [
				"storage:org_storage:logs:2026-11-22",
				"storage:org_storage:logs:2026-11-23",
				"storage:org_storage:logs:2026-11-24",
			])
		}),
	)

	it.effect("bills a ledger row for exactly its retention days, from the day it was received", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 0, 3, 30)
			const tracked: Array<Tracked> = []
			yield* Effect.forEach(Arr.range(1, 10), (daysLater) =>
				meterStorage(SETTLED + daysLater * DAY_MS).pipe(
					Effect.provide([db.layer, recordingAutumn(tracked)]),
				),
			)
			assert.deepStrictEqual(keysOf(tracked), [
				"storage:org_storage:logs:2026-11-25",
				"storage:org_storage:logs:2026-11-26",
				"storage:org_storage:logs:2026-11-27",
			])
		}),
	)

	it.effect("records only the orgs Autumn accepted in a mixed tick, taking a 409 as accepted", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 1, 30, 30)
			yield* ledger(db, "org_refused", "logs", 1, 30, 30)
			yield* ledger(db, "org_counted", "logs", 1, 30, 30)
			const tracked: Array<Tracked> = []
			let refuse = true
			const autumn = recordingAutumn(tracked, (call) =>
				call.body.customer_id === "org_refused"
					? refuse
						? 503
						: 200
					: call.body.customer_id === "org_counted"
						? 409
						: 200,
			)
			const meter = (nowMs: number) => meterStorage(nowMs).pipe(Effect.provide([db.layer, autumn]))

			const first = yield* meter(SETTLED)
			assert.strictEqual(first.charges, 2)
			assert.strictEqual(first.failed, 1)

			refuse = false
			const second = yield* meter(SETTLED + 3_600_000)
			assert.deepStrictEqual(keysOf(tracked.slice(3)), ["storage:org_refused:logs:2026-11-24"])
			assert.strictEqual(second.charges, 1)
		}),
	)

	it.effect("bills a day again until every signal it stored is accepted", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 1, 30, 30)
			yield* ledger(db, ORG, "traces", 1, 30, 30)
			const tracked: Array<Tracked> = []
			let refuseTraces = true
			const autumn = recordingAutumn(tracked, (call) =>
				call.body.feature_id === "storage_traces" && refuseTraces ? 503 : 200,
			)
			const meter = (nowMs: number) => meterStorage(nowMs).pipe(Effect.provide([db.layer, autumn]))

			const first = yield* meter(SETTLED)
			assert.strictEqual(first.failed, 1)

			// Both go again under their keys; Autumn counts the logs key once.
			refuseTraces = false
			yield* meter(SETTLED + 3_600_000)
			assert.deepStrictEqual(keysOf(tracked.slice(2)), [
				"storage:org_storage:logs:2026-11-24",
				"storage:org_storage:traces:2026-11-24",
			])

			// Now the day is recorded, and a later tick sends nothing.
			yield* meter(SETTLED + 2 * 3_600_000)
			assert.strictEqual(tracked.length, 4)
		}),
	)

	it.effect("records nothing as billed when Autumn has no key, and bills it once a key is set", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "logs", 1, 30, 30)
			const tracked: Array<Tracked> = []

			const unkeyed = yield* meterStorage(SETTLED).pipe(
				Effect.provide([db.layer, recordingAutumn(tracked, () => 200, { AUTUMN_SECRET_KEY: " " })]),
			)
			assert.strictEqual(unkeyed.charges, 0)
			assert.strictEqual(unkeyed.unmetered, 1)
			assert.strictEqual(tracked.length, 0)

			const keyed = yield* meterStorage(SETTLED + 3_600_000).pipe(
				Effect.provide([db.layer, recordingAutumn(tracked)]),
			)
			assert.strictEqual(keyed.charges, 1)
			assert.deepStrictEqual(keysOf(tracked), ["storage:org_storage:logs:2026-11-24"])
		}),
	)

	it.effect("prunes days past the longest period and bills only early in the UTC day", () =>
		Effect.gen(function* () {
			const db = createTestDb(trackedDbs)
			yield* ledger(db, ORG, "events", 740, 730, 5)
			yield* ledger(db, ORG, "logs", 729, 730, 5)
			const tracked: Array<Tracked> = []
			const provideAll = Effect.provide([db.layer, recordingAutumn(tracked)])

			const result = yield* meterStorage(SETTLED).pipe(provideAll)
			assert.strictEqual(result.pruned, 1)
			// The 730-day row bills its last day, 2026-11-24, after a 7-day backfill of earlier ones.
			assert.strictEqual(tracked.length, BACKFILL_DAYS)

			yield* TestClock.setTime(TODAY + DAY_MS + SETTLE_MS + 4 * 3_600_000)
			yield* runStorageMetering.pipe(provideAll)
			assert.strictEqual(tracked.length, BACKFILL_DAYS)
		}),
	)
})
