// What storing telemetry costs: every GB the gateway billed at ingest, for as long as it is
// kept. Pure, so the web app can price a retention period before it is saved.

import { Schema } from "effect"

/** The Autumn feature storage is tracked to, in GB-months. */
export const STORAGE_FEATURE_ID = "storage"

/** The signals billed per GB at ingest, so stored per GB. Named as their Autumn ingest features. */
export const STORAGE_SIGNALS = ["traces", "logs", "metrics", "profiles"] as const
export const StorageSignal = Schema.Literals(STORAGE_SIGNALS)
export type StorageSignal = typeof StorageSignal.Type

/** Dollar rates, until they are read from the billing catalog. */
export const DATA_RATES = {
	/** Per GB ingested past the plan's included GB. */
	ingestPerGb: 0.15,
	/** Per GB stored for a month, with nothing included. */
	storagePerGbMonth: 0.15,
} as const

/** The mean length of a month, so a period's monthly cost does not depend on the calendar. */
export const DAYS_PER_MONTH = 365.25 / 12

/**
 * What keeping a signal for `days` costs a month once the period is full: the GB stored then
 * (each day's ingest, kept `days` days) at `rate` per GB-month.
 */
export const estimateMonthlyStorageCost = (avgDailyGb: number, days: number, rate: number): number =>
	Math.max(0, avgDailyGb) * Math.max(0, days) * rate

/** Days in the UTC month holding `epochMs`. */
export const daysInUtcMonth = (epochMs: number): number => {
	const date = new Date(epochMs)
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}

/** One day's share of a month's storage: GB stored that day, in GB-months. */
export const dailyGbMonths = (storedGb: number, epochMs: number): number => storedGb / daysInUtcMonth(epochMs)

export const DataRates = Schema.Struct({
	ingestPerGb: Schema.Number,
	storagePerGbMonth: Schema.Number,
})

export const StorageSignalUsage = Schema.Struct({
	signal: StorageSignal,
	/** GB still inside its retention period now. */
	storedGb: Schema.Number,
	/** Mean GB ingested a day over the last 7 complete UTC days. */
	avgDailyGb: Schema.Number,
})
export type StorageSignalUsage = typeof StorageSignalUsage.Type

export const StorageUsageSummary = Schema.Struct({
	signals: Schema.Array(StorageSignalUsage),
	rates: DataRates,
}).annotate({ identifier: "@maple/StorageUsageSummary", title: "Storage Usage Summary" })
export type StorageUsageSummary = typeof StorageUsageSummary.Type
