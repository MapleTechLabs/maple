import type { V2SourceUsage } from "@maple/domain/http/v2"
import { DateTime, Option } from "effect"

// `usageRows` and `usageTotals`.

const HOUR_MS = 3_600_000

/** The API's ISO timestamps always parse; `NaN` mirrors `new Date(bad).getTime()` otherwise. */
const epochOf = (iso: string): number =>
	Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => Number.NaN)

export type UsageRow = Readonly<{ bucket: string; Spans: number; Logs: number; Metrics: number }>

/** 24 hourly rows ending at the window's end; hours the API omitted count as zero. */
export const usageRows = (usage: V2SourceUsage): ReadonlyArray<UsageRow> => {
	// `window_end` is exclusive: the last row is the hour holding the instant before it.
	const end = Math.floor((epochOf(usage.window_end) - 1) / HOUR_MS) * HOUR_MS
	const byHour = new Map(usage.buckets.map((bucket) => [epochOf(bucket.hour), bucket]))
	return Array.from({ length: 24 }, (_, index) => {
		const hour = end - (23 - index) * HOUR_MS
		const bucket = byHour.get(hour)
		return {
			bucket: new Date(hour).toISOString(),
			Spans: bucket?.spans ?? 0,
			Logs: bucket?.logs ?? 0,
			Metrics: bucket?.metrics ?? 0,
		}
	})
}

export type UsageTotals = Readonly<{ spans: number; logs: number; metrics: number; bytes: number }>

export const ZERO_USAGE: UsageTotals = { spans: 0, logs: 0, metrics: 0, bytes: 0 }

export const usageTotals = (usage: V2SourceUsage): UsageTotals =>
	usage.buckets.reduce(
		(sum, bucket) => ({
			spans: sum.spans + bucket.spans,
			logs: sum.logs + bucket.logs,
			metrics: sum.metrics + bucket.metrics,
			bytes: sum.bytes + bucket.bytes,
		}),
		ZERO_USAGE,
	)
