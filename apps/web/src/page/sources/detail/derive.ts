import type { V2Source, V2SourceUsage } from "@maple/domain/http/v2"
import { DateTime, Option } from "effect"

// `usageRows` and the overview's metrics-only set.

const HOUR_MS = 3_600_000

/** The API's ISO timestamps always parse; `NaN` mirrors `new Date(bad).getTime()` otherwise. */
const epochOf = (iso: string): number =>
	Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => Number.NaN)

export type UsageRow = Readonly<{ bucket: string; Spans: number; Logs: number }>

/** 24 hourly rows ending at the window's end; hours the API omitted count as zero. */
export const usageRows = (usage: V2SourceUsage): ReadonlyArray<UsageRow> => {
	// `window_end` is exclusive: the last row is the hour holding the instant before it.
	const end = Math.floor((epochOf(usage.window_end) - 1) / HOUR_MS) * HOUR_MS
	const byHour = new Map(usage.buckets.map((bucket) => [epochOf(bucket.hour), bucket]))
	return Array.from({ length: 24 }, (_, index) => {
		const hour = end - (23 - index) * HOUR_MS
		const bucket = byHour.get(hour)
		return { bucket: new Date(hour).toISOString(), Spans: bucket?.spans ?? 0, Logs: bucket?.logs ?? 0 }
	})
}

/** Integrations that only send metrics, which the usage counts do not cover yet. */
export const METRICS_ONLY: ReadonlySet<V2Source["platform"]> = new Set([
	"prometheus",
	"cloudflare",
	"railway",
	"planetscale",
])

export const usageTotals = (usage: V2SourceUsage) =>
	usage.buckets.reduce(
		(sum, bucket) => ({ spans: sum.spans + bucket.spans, logs: sum.logs + bucket.logs }),
		{ spans: 0, logs: 0 },
	)
