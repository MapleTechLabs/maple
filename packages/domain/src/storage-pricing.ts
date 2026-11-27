// What storing telemetry costs: every GB the gateway billed at ingest, for as long as it is
// kept, past a monthly allowance per signal. Pure, so the web app can price a retention period
// before it is saved.

import { Record as Rec, Schema } from "effect"

/** The signals billed per GB at ingest, so stored per GB. Named as their Autumn ingest features. */
export const STORAGE_SIGNALS = ["traces", "logs", "metrics", "profiles"] as const
export const StorageSignal = Schema.Literals(STORAGE_SIGNALS)
export type StorageSignal = typeof StorageSignal.Type

/** The Autumn feature a signal's storage is tracked to, in GB-months, so each has its own allowance. */
export const STORAGE_FEATURE_IDS = {
	traces: "storage_traces",
	logs: "storage_logs",
	metrics: "storage_metrics",
	profiles: "storage_profiles",
} as const satisfies Record<StorageSignal, string>

/**
 * GB-months of storage the Startup plan includes per signal each month: what its included ingest
 * needs at the default retention (metrics are kept 90 days, so three times their 100 GB), so a
 * signal sent at its allowance and kept its default period costs nothing more.
 */
export const INCLUDED_STORAGE_GB_MONTHS = {
	traces: 100,
	logs: 100,
	metrics: 300,
	profiles: 10,
} as const satisfies Record<StorageSignal, number>

const isStorageSignal = Schema.is(StorageSignal)

const storageFeatureIds: ReadonlySet<string> = new Set(Rec.values(STORAGE_FEATURE_IDS))

/** A per-signal storage feature: GB-months kept, billed past what the plan includes for that signal. */
export const isStorageFeatureId = (featureId: string): boolean => storageFeatureIds.has(featureId)

/** The storage feature for a ledger row's signal, or undefined for a signal storage does not bill. */
export const storageFeatureOf = (signal: string): string | undefined =>
	isStorageSignal(signal) ? STORAGE_FEATURE_IDS[signal] : undefined

/** Dollar rates, until they are read from the billing catalog. */
export const DATA_RATES = {
	/** Per GB ingested past the plan's included GB. */
	ingestPerGb: 0.15,
	/** Per GB stored for a month, past the plan's included GB-months for that signal. */
	storagePerGbMonth: 0.15,
} as const

/** Per GB ingested past the plan's included GB, per signal: profiles store about 28 times their wire size. */
export const INGEST_RATES_PER_GB = {
	traces: DATA_RATES.ingestPerGb,
	logs: DATA_RATES.ingestPerGb,
	metrics: DATA_RATES.ingestPerGb,
	profiles: 0.6,
} as const satisfies Record<StorageSignal, number>

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

export const StorageSignalUsage = Schema.Struct({
	signal: StorageSignal,
	/** GB still inside its retention period now. */
	storedGb: Schema.Number,
	/** Mean GB ingested a day over the last 7 complete UTC days. */
	avgDailyGb: Schema.Number,
	/** Dollars per GB ingested past the plan's included GB, for this signal. */
	ingestPerGb: Schema.Number,
})
export type StorageSignalUsage = typeof StorageSignalUsage.Type

export const StorageRates = Schema.Struct({
	storagePerGbMonth: Schema.Number,
})

export const StorageUsageSummary = Schema.Struct({
	signals: Schema.Array(StorageSignalUsage),
	rates: StorageRates,
}).annotate({ identifier: "@maple/StorageUsageSummary", title: "Storage Usage Summary" })
export type StorageUsageSummary = typeof StorageUsageSummary.Type
