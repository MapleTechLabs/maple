import * as PG from "@maple-dev/effect-orm/postgres"
import { IngestStorageLedger, OrgBillingLinks, StorageBillingRuns } from "@maple/db/tables"
import { BillingCustomerId } from "@maple/domain/http"
import { MAX_RETENTION_DAYS } from "@maple/domain/retention"
import { dailyGbMonths, storageFeatureOf } from "@maple/domain/storage-pricing"
import type { OrgId } from "@maple/primitives"
import { Array as Arr, Clock, DateTime, Effect, Record as Rec, Result, Schema, Tuple } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { trackFeatureUsageOrFail } from "@maple/backend/services/billing/autumn-tracker"
import { bytesToGb, DAY_MS, keptOn, utcDayStart } from "@maple/backend/services/billing/StorageUsageService"

/**
 * Daily storage billing from `ingest_storage_ledger`: for each completed UTC day, each org's GB
 * still inside its retention period that day, per signal, tracked to that signal's Autumn storage
 * feature (`STORAGE_FEATURE_IDS`) as the day's share of a GB-month. Autumn applies each signal's
 * included GB-months, so the plan's allowance is not worked out here.
 *
 * A ledger row is the bytes Maple received on its day, stored under the period stamped then. It
 * bills from that day for exactly that many days, even though the warehouse expires rows by event
 * time: data received late or early is billed for the period it was stored under, never longer.
 *
 * Rides the API worker's hourly cron; a day bills from `SETTLE_MS` past its end, for
 * `METERING_HOURS`, so the gateway's last flush of the day has landed. Each (org, day)
 * Autumn accepts is recorded in `storage_billing_runs`; any day of the last `BACKFILL_DAYS` without
 * one is billed again, oldest first, under its own idempotency key, so a retry bills once.
 * Orgs on their own ClickHouse have no ledger rows: the gateway records only what Maple stores.
 */
export const METERING_HOURS = 4

/** Time after midnight UTC before the day just ended bills: the gateway flushes every minute. */
export const SETTLE_MS = 60 * 60 * 1000

/** Completed days a failed bill is retried for. */
export const BACKFILL_DAYS = 7

/** Ledger days kept past the longest period and the backfill, so a day still billable stays. */
const PRUNE_LEDGER_AFTER_DAYS = MAX_RETENTION_DAYS + BACKFILL_DAYS + 1

/** Billing runs kept for reading back what was billed. */
const PRUNE_RUNS_AFTER_DAYS = 90

/** Some days' storage did not reach Autumn; they are billed again on the next tick. */
export class StorageMeteringIncompleteError extends Schema.TaggedError<StorageMeteringIncompleteError>()(
	"@maple/billing/StorageMeteringIncompleteError",
	{ message: Schema.String, failed: Schema.Number },
) {}

const isoDay = (epochMs: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMs))

const usageKey = (orgId: string, signal: string, dayMs: number) =>
	`storage:${orgId}:${signal}:${isoDay(dayMs)}`

const runKey = (orgId: string, dayMs: number) => `${orgId}:${dayMs}`

const daySumKey = (dayMs: number) => `bytes_${dayMs}`

interface Charge {
	readonly orgId: OrgId
	readonly signal: string
	readonly featureId: string
	readonly dayMs: number
	readonly storedGb: number
	readonly value: number
}

/**
 * Bills every completed UTC day of the last `BACKFILL_DAYS` before `nowMs` that an org has not
 * been billed for, and prunes rows nothing bills any more.
 */
export const meterStorage = Effect.fn("StorageMetering.meter")(function* (nowMs: number) {
	const todayMs = utcDayStart(nowMs)
	// Oldest first, ending with the last day settled `SETTLE_MS` ago; today is never billed.
	const lastDayMs = utcDayStart(nowMs - SETTLE_MS) - DAY_MS
	const days = Arr.makeBy(BACKFILL_DAYS, (index) => lastDayMs - (BACKFILL_DAYS - 1 - index) * DAY_MS)
	const firstDayMs = days[0] ?? lastDayMs
	const database = yield* Database

	const { stored, links, pruned } = yield* database.execute((db) =>
		Effect.gen(function* () {
			const pruned = yield* db.run(
				PG.deleteFrom(IngestStorageLedger)
					.where(($) => [$.day.lt(todayMs - PRUNE_LEDGER_AFTER_DAYS * DAY_MS)])
					.returning("orgId"),
			)
			yield* db.run(
				PG.deleteFrom(StorageBillingRuns).where(($) => [
					$.day.lt(todayMs - PRUNE_RUNS_AFTER_DAYS * DAY_MS),
				]),
			)
			const billed = yield* db.run(
				PG.from(StorageBillingRuns)
					.select(($) => ({ orgId: $.orgId, day: $.day }))
					.where(($) => [$.day.gte(firstDayMs)]),
			)
			const alreadyBilled = new Set(Arr.map(billed, (run) => runKey(run.orgId, run.day)))
			// One scan of the rows kept on any day of the window, one sum per day.
			const sums = yield* db.run(
				PG.from(IngestStorageLedger)
					.select(($) =>
						Object.assign(
							{ orgId: $.orgId, signal: $.signal },
							Rec.fromEntries(
								Arr.map(days, (dayMs) =>
									Tuple.make(
										daySumKey(dayMs),
										// Only bytes received by the end of the billed day.
										PG.sumIf($.bytes, PG.and($.day.lte(dayMs), keptOn($, dayMs))),
									),
								),
							),
						),
					)
					.where(($) => [$.day.lte(lastDayMs), keptOn($, firstDayMs)])
					.groupBy("orgId", "signal"),
			)
			// Oldest day first, skipping each (org, day) already billed.
			const stored = Arr.flatMap(days, (dayMs) =>
				Arr.flatMap(sums, (row) =>
					alreadyBilled.has(runKey(row.orgId, dayMs))
						? []
						: [
								{
									orgId: row.orgId,
									signal: row.signal,
									dayMs,
									bytes: row[daySumKey(dayMs)] ?? null,
								},
							],
				),
			)
			const orgIds = Arr.dedupe(Arr.map(stored, (row) => row.orgId))
			const links = Arr.isArrayNonEmpty(orgIds)
				? yield* db.run(
						PG.from(OrgBillingLinks)
							.select(($) => ({ orgId: $.orgId, billingOrgId: $.billingOrgId }))
							.where(($) => [PG.inList($.orgId, orgIds)]),
					)
				: []
			return { stored, links, pruned: pruned.length }
		}),
	)

	const billingOrgOf = new Map(Arr.map(links, (link): [string, string] => [link.orgId, link.billingOrgId]))
	const charges = Arr.flatMap(stored, (row): ReadonlyArray<Charge> => {
		const storedGb = bytesToGb(row.bytes)
		const featureId = storageFeatureOf(row.signal)
		return storedGb > 0 && featureId !== undefined
			? [
					{
						orgId: row.orgId,
						signal: row.signal,
						featureId,
						dayMs: row.dayMs,
						storedGb,
						value: dailyGbMonths(storedGb, row.dayMs),
					},
				]
			: []
	})

	// The backlog is sent in day order.
	const results = yield* Effect.forEach(
		charges,
		(charge) =>
			trackFeatureUsageOrFail({
				// A member org bills to its billing org's customer, as its ingest does.
				customerId: BillingCustomerId.make(billingOrgOf.get(charge.orgId) ?? charge.orgId),
				featureId: charge.featureId,
				value: charge.value,
				idempotencyKey: usageKey(charge.orgId, charge.signal, charge.dayMs),
			}).pipe(
				Effect.map((outcome) => ({ charge, outcome })),
				Effect.tapError((error) =>
					Effect.logError("[billing] storage day not billed").pipe(
						Effect.annotateLogs({
							orgId: charge.orgId,
							signal: charge.signal,
							day: isoDay(charge.dayMs),
							error: error.message,
						}),
					),
				),
				Effect.result,
			),
		{ concurrency: 8 },
	)
	const sent = Arr.flatMap(results, (result) => (Result.isSuccess(result) ? [result.success] : []))
	const accepted = Arr.flatMap(sent, ({ charge, outcome }) => (outcome === "accepted" ? [charge] : []))
	// A day is recorded once every signal it stored was accepted; the rest go again next tick,
	// and Autumn answers the signals it already counted with 409 under their keys.
	const acceptedCharges = new Set(accepted)
	const notAccepted = new Set(
		Arr.flatMap(charges, (charge) =>
			acceptedCharges.has(charge) ? [] : [runKey(charge.orgId, charge.dayMs)],
		),
	)
	const completedDays = Rec.values(
		Arr.groupBy(
			Arr.filter(accepted, (charge) => !notAccepted.has(runKey(charge.orgId, charge.dayMs))),
			(charge) => runKey(charge.orgId, charge.dayMs),
		),
	)
	const failed = results.length - sent.length
	// No Autumn key, or the default org: nothing was billed, so no run is recorded for it.
	const unmetered = sent.length - accepted.length
	if (unmetered > 0) {
		yield* Effect.logError("[billing] storage not metered: no Autumn key, or the default org").pipe(
			Effect.annotateLogs({ unmetered }),
		)
	}

	// A run lost here is billed again next tick under the same key, which Autumn answers with 409.
	if (Arr.isArrayNonEmpty(completedDays)) {
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(StorageBillingRuns)
					.values(
						Arr.map(completedDays, ([first, ...rest]) => ({
							orgId: first.orgId,
							day: first.dayMs,
							gbMonths: Arr.reduce(rest, first.value, (sum, charge) => sum + charge.value),
						})),
					)
					.onConflictDoNothing(),
			),
		)
	}

	const storedGbTotal = Arr.reduce(accepted, 0, (sum, charge) => sum + charge.storedGb)
	yield* Effect.annotateCurrentSpan({
		"maple.storage_metering.from_day": isoDay(firstDayMs),
		"maple.storage_metering.to_day": isoDay(lastDayMs),
		"maple.storage_metering.charges": charges.length,
		"maple.storage_metering.failed": failed,
		"maple.storage_metering.unmetered": unmetered,
		"maple.storage_metering.stored_gb": storedGbTotal,
		"maple.storage_metering.pruned_rows": pruned,
	})
	return { charges: accepted.length, failed, unmetered, storedGb: storedGbTotal, pruned }
})

/** The hourly tick: bills for `METERING_HOURS` from `SETTLE_MS` past midnight UTC, else does nothing. */
export const runStorageMetering = Effect.gen(function* () {
	const nowMs = yield* Clock.currentTimeMillis
	const sinceMidnightMs = nowMs - utcDayStart(nowMs)
	if (sinceMidnightMs < SETTLE_MS || sinceMidnightMs >= SETTLE_MS + METERING_HOURS * 60 * 60 * 1000) {
		yield* Effect.annotateCurrentSpan({ "maple.storage_metering.outcome": "skipped" })
		return
	}
	const { charges, failed, storedGb } = yield* meterStorage(nowMs)
	if (failed > 0) {
		return yield* new StorageMeteringIncompleteError({
			message: `${failed} storage charges did not reach Autumn`,
			failed,
		})
	}
	yield* Effect.annotateCurrentSpan({ "maple.storage_metering.outcome": "completed" })
	yield* Effect.logInfo("[billing] storage metering tick complete").pipe(
		Effect.annotateLogs({ charges, storedGb }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "maple.storage_metering.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[billing] storage metering tick failed").pipe(
					Effect.annotateLogs({ error: String(cause) }),
				),
			),
		),
	),
	Effect.withSpan("StorageMetering.tick"),
)
