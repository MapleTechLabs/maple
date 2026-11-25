import * as PG from "@maple-dev/effect-orm/postgres"
import { IngestStorageLedger } from "@maple/db/tables"
import { RetentionPersistenceError } from "@maple/domain/http"
import {
	DATA_RATES,
	STORAGE_SIGNALS,
	type StorageSignalUsage,
	type StorageUsageSummary,
} from "@maple/domain/storage-pricing"
import type { OrgId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

export const DAY_MS = 24 * 60 * 60 * 1000
/** Decimal, as the gateway meters and Autumn prices. */
export const BYTES_PER_GB = 1_000_000_000
/** Complete UTC days the daily ingest average is taken over. */
export const AVERAGE_WINDOW_DAYS = 7

export const utcDayStart = (epochMs: number): number => epochMs - (epochMs % DAY_MS)

/** Postgres sums int8 as numeric, which the driver may hand back as a string. */
export const bytesToGb = (bytes: number | string | null): number => Number(bytes ?? 0) / BYTES_PER_GB

/** A ledger row still inside its period on the UTC day starting at `todayMs`. */
export const keptOn = (
	ledger: { readonly day: PG.SqlTemplateValue; readonly retentionDays: PG.SqlTemplateValue },
	todayMs: number,
) =>
	PG.sql
		.cond`${ledger.day} + ${ledger.retentionDays} * interval '1 day' > to_timestamp(${todayMs / 1000}::float8)`

/** GB per signal from summed ledger rows. */
export const gbBySignal = (
	rows: ReadonlyArray<{ readonly signal: string; readonly bytes: number | string | null }>,
): ReadonlyMap<string, number> =>
	new Map(Arr.map(rows, (row): [string, number] => [row.signal, bytesToGb(row.bytes)]))

export interface StorageUsageServiceApi {
	/** Per stored signal: GB kept now and the daily ingest average, with the rates. */
	readonly summary: (orgId: OrgId) => Effect.Effect<StorageUsageSummary, RetentionPersistenceError>
}

const toPersistenceError = makePersistenceErrorMapper(RetentionPersistenceError, "Storage usage read failed")

export class StorageUsageService extends Context.Service<StorageUsageService, StorageUsageServiceApi>()(
	"@maple/backend/services/billing/StorageUsageService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "StorageUsageService", toPersistenceError)

			const summary = Effect.fn("StorageUsageService.summary")(function* (orgId: OrgId) {
				const nowMs = yield* Clock.currentTimeMillis
				const todayMs = utcDayStart(nowMs)
				const windowStartMs = todayMs - AVERAGE_WINDOW_DAYS * DAY_MS
				const { stored, recent } = yield* dbExecute((db) =>
					Effect.all({
						stored: db.run(
							PG.from(IngestStorageLedger)
								.select(($) => ({ signal: $.signal, bytes: PG.sum($.bytes) }))
								.where(($) => [$.orgId.eq(orgId), keptOn($, todayMs)])
								.groupBy("signal"),
						),
						recent: db.run(
							PG.from(IngestStorageLedger)
								.select(($) => ({ signal: $.signal, bytes: PG.sum($.bytes) }))
								.where(($) => [
									$.orgId.eq(orgId),
									$.day.gte(windowStartMs),
									$.day.lt(todayMs),
								])
								.groupBy("signal"),
						),
					}),
				)
				const storedGb = gbBySignal(stored)
				const recentGb = gbBySignal(recent)
				const signals = Arr.map(STORAGE_SIGNALS, (signal): StorageSignalUsage => ({
					signal,
					storedGb: storedGb.get(signal) ?? 0,
					avgDailyGb: (recentGb.get(signal) ?? 0) / AVERAGE_WINDOW_DAYS,
				}))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.storage.stored_gb": Arr.reduce(signals, 0, (sum, usage) => sum + usage.storedGb),
				})
				return { signals, rates: DATA_RATES } satisfies StorageUsageSummary
			})

			return { summary } satisfies StorageUsageServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
