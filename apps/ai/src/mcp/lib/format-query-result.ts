import { formatDurationFromMs, formatNumber, formatPercent } from "./format"
import type { QueryDataUnit } from "@maple/domain"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Option, String as Str } from "effect"

/** The `HH:mm:ss` of a bucket timestamp, which is all a single-day table row needs. */
export function formatBucket(bucket: string): string {
	return Option.match(Str.match(/T(\d{2}:\d{2}:\d{2})/)(bucket), {
		onNone: () => Str.slice(11, 19)(bucket),
		onSome: (match) => match[1] ?? Str.slice(11, 19)(bucket),
	})
}

/** Epoch ms of a bucket timestamp; a zone-less value is UTC, as the warehouse returns it. */
const bucketMs = (bucket: string): number => {
	const iso = Str.replace(" ", "T")(Str.trim(bucket))
	return parseWarehouseDateTime(iso)
}

export interface BucketLabels {
	readonly labels: ReadonlyArray<string>
	/** True when the last bucket ends after the window's end, so it holds only part of its span. */
	readonly lastIsPartial: boolean
}

/**
 * Row labels for a series: `HH:mm:ss`, with the date once the buckets span more than one UTC
 * day, and `(partial)` on a trailing bucket that runs past `windowEnd`. Spans land when they
 * complete, so that bucket under-reports and must not read as a drop.
 */
export function bucketLabels(
	buckets: ReadonlyArray<string>,
	windowEnd: string,
	bucketSeconds?: number,
): BucketLabels {
	const starts = Arr.map(buckets, bucketMs)
	const dates = new Set(Arr.map(buckets, (bucket) => Str.slice(0, 10)(Str.trim(bucket))))
	const label = (bucket: string) =>
		dates.size > 1
			? `${Str.slice(0, 10)(Str.trim(bucket))} ${formatBucket(bucket)}`
			: formatBucket(bucket)
	const gaps = Arr.flatMap(starts.slice(1), (start, i) => {
		const gap = start - (starts[i] ?? start)
		return gap > 0 ? [gap] : []
	})
	const widthMs =
		bucketSeconds !== undefined ? bucketSeconds * 1000 : gaps.length > 0 ? Math.min(...gaps) : undefined
	const last = starts[starts.length - 1]
	const lastIsPartial = widthMs !== undefined && last !== undefined && last + widthMs > bucketMs(windowEnd)
	const labels = Arr.map(buckets, (bucket, i) =>
		lastIsPartial && i === buckets.length - 1 ? `${label(bucket)} (partial)` : label(bucket),
	)
	return { labels, lastIsPartial }
}

/** Shown under a series with a partial trailing bucket. */
export const PARTIAL_BUCKET_NOTE =
	"(partial): the last bucket runs past end_time and is still filling; spans land when they complete, so it under-reports. Do not read it as a drop."

export function formatMetricValue(metric: string, value: number): string {
	if (Str.includes("duration")(metric)) return formatDurationFromMs(value)
	if (metric === "error_rate") return formatPercent(value)
	// Trace counts are sample-weighted sums; fractional spans read as noise.
	if (metric === "count") return formatNumber(Math.round(value))
	return formatNumber(value)
}

export function inferQueryDataUnit(source: string, metric: string, metricName?: string): QueryDataUnit {
	if (source === "traces") {
		if (metric === "error_rate") return "percent"
		if (Str.includes("duration")(metric)) return "duration_ms"
		return "number"
	}
	if (source === "logs") return "number"
	// metrics
	if (metricName) {
		const lower = Str.toLowerCase(metricName)
		if (/\b(error[._-]?rate|percentage|percent)\b/.test(lower)) return "percent"
		if (/[._](seconds|s)$/.test(lower) || /\b(duration[._]seconds)\b/.test(lower)) return "duration_s"
		if (/\b(duration|latency|response[._]time)\b/.test(lower)) return "duration_ms"
		if (/\b(bytes|memory|size)\b/.test(lower)) return "bytes"
	}
	if (metric === "rate") return "requests_per_sec"
	return "number"
}
