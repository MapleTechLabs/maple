import * as PG from "@maple-dev/effect-orm/postgres"
import { IngestStorageLedger, OrgBillingLinks } from "@maple/db/tables"
import { BillingCustomerId } from "@maple/domain/http"
import { MAX_RETENTION_DAYS } from "@maple/domain/retention"
import { dailyGbMonths, STORAGE_FEATURE_ID } from "@maple/domain/storage-pricing"
import { Array as Arr, Clock, DateTime, Effect } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { trackFeatureUsage } from "@maple/backend/services/billing/autumn-tracker"
import { bytesToGb, DAY_MS, keptOn, utcDayStart } from "@maple/backend/services/billing/StorageUsageService"

/**
 * Daily storage billing from `ingest_storage_ledger`: each org's GB still inside its retention
 * period, tracked to Autumn's `storage` feature as that day's share of a GB-month.
 *
 * Rides the API worker's hourly cron. Only the first hours of a UTC day bill, each under the
 * same idempotency key per org and day, so a failed tick is retried and a rerun bills once.
 * Orgs on their own ClickHouse have no ledger rows: the gateway records only what Maple stores.
 */
export const METERING_HOURS = 4

/** Ledger days kept past the longest period, so a day is never pruned while it still bills. */
const PRUNE_AFTER_DAYS = MAX_RETENTION_DAYS + 1

const isoDay = (epochMs: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMs))

const usageKey = (orgId: string, todayMs: number) => `storage:${orgId}:${isoDay(todayMs)}`

/** Bills the UTC day holding `nowMs` and prunes rows past every period. */
export const meterStorage = Effect.fn("StorageMetering.meter")(function* (nowMs: number) {
	const todayMs = utcDayStart(nowMs)
	const database = yield* Database

	const { stored, links, pruned } = yield* database.execute((db) =>
		Effect.gen(function* () {
			const pruned = yield* db.run(
				PG.deleteFrom(IngestStorageLedger)
					.where(($) => [$.day.lt(todayMs - PRUNE_AFTER_DAYS * DAY_MS)])
					.returning("orgId"),
			)
			const stored = yield* db.run(
				PG.from(IngestStorageLedger)
					.select(($) => ({ orgId: $.orgId, bytes: PG.sum($.bytes) }))
					.where(($) => [keptOn($, todayMs)])
					.groupBy("orgId"),
			)
			const orgIds = Arr.map(stored, (row) => row.orgId)
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
	const charges = Arr.flatMap(stored, (row) => {
		const storedGb = bytesToGb(row.bytes)
		return storedGb > 0 ? [{ orgId: row.orgId, storedGb, value: dailyGbMonths(storedGb, todayMs) }] : []
	})

	yield* Effect.forEach(
		charges,
		(charge) =>
			trackFeatureUsage({
				// A member org bills to its billing org's customer, as its ingest does.
				customerId: BillingCustomerId.make(billingOrgOf.get(charge.orgId) ?? charge.orgId),
				featureId: STORAGE_FEATURE_ID,
				value: charge.value,
				idempotencyKey: usageKey(charge.orgId, todayMs),
			}),
		{ concurrency: 8, discard: true },
	)

	const storedGbTotal = Arr.reduce(charges, 0, (sum, charge) => sum + charge.storedGb)
	yield* Effect.annotateCurrentSpan({
		"maple.storage_metering.day": isoDay(todayMs),
		"maple.storage_metering.orgs": charges.length,
		"maple.storage_metering.stored_gb": storedGbTotal,
		"maple.storage_metering.pruned_rows": pruned,
	})
	return { orgs: charges.length, storedGb: storedGbTotal, pruned }
})

/** The hourly tick: bills in the first `METERING_HOURS` of the UTC day, else does nothing. */
export const runStorageMetering = Effect.gen(function* () {
	const nowMs = yield* Clock.currentTimeMillis
	if (nowMs - utcDayStart(nowMs) >= METERING_HOURS * 60 * 60 * 1000) {
		yield* Effect.annotateCurrentSpan({ "maple.storage_metering.outcome": "skipped" })
		return
	}
	const { orgs, storedGb } = yield* meterStorage(nowMs)
	yield* Effect.annotateCurrentSpan({ "maple.storage_metering.outcome": "completed" })
	yield* Effect.logInfo("[billing] storage metering tick complete").pipe(
		Effect.annotateLogs({ orgs, storedGb }),
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
