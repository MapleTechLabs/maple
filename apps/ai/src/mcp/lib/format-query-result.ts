import { formatDurationFromMs, formatNumber, formatPercent } from "./format"
import type { QueryDataUnit } from "@maple/domain"

/** The `HH:mm:ss` of a bucket timestamp, which is all a single-day table row needs. */
export function formatBucket(bucket: string): string {
	const match = bucket.match(/T(\d{2}:\d{2}:\d{2})/)
	return match ? match[1] : bucket.slice(11, 19)
}

/** Epoch ms of a bucket timestamp; a zone-less value is UTC, as the warehouse returns it. */
const bucketMs = (bucket: string): number => {
	const iso = bucket.trim().replace(" ", "T")
	return Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
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
	const starts = buckets.map(bucketMs)
	const dates = new Set(buckets.map((bucket) => bucket.trim().slice(0, 10)))
	const label = (bucket: string) =>
		dates.size > 1 ? `${bucket.trim().slice(0, 10)} ${formatBucket(bucket)}` : formatBucket(bucket)
	const gaps = starts.slice(1).flatMap((start, i) => {
		const gap = start - (starts[i] ?? start)
		return gap > 0 ? [gap] : []
	})
	const widthMs =
		bucketSeconds !== undefined ? bucketSeconds * 1000 : gaps.length > 0 ? Math.min(...gaps) : undefined
	const last = starts[starts.length - 1]
	const lastIsPartial = widthMs !== undefined && last !== undefined && last + widthMs > bucketMs(windowEnd)
	const labels = buckets.map((bucket, i) =>
		lastIsPartial && i === buckets.length - 1 ? `${label(bucket)} (partial)` : label(bucket),
	)
	return { labels, lastIsPartial }
}

/** Shown under a series with a partial trailing bucket. */
export const PARTIAL_BUCKET_NOTE =
	"(partial): the last bucket runs past end_time and is still filling; spans land when they complete, so it under-reports. Do not read it as a drop."

export function formatMetricValue(metric: string, value: number): string {
	if (metric.includes("duration")) return formatDurationFromMs(value)
	if (metric === "error_rate") return formatPercent(value)
	return formatNumber(value)
}

export function inferQueryDataUnit(source: string, metric: string, metricName?: string): QueryDataUnit {
	if (source === "traces") {
		if (metric === "error_rate") return "percent"
		if (metric.includes("duration")) return "duration_ms"
		return "number"
	}
	if (source === "logs") return "number"
	// metrics
	if (metricName) {
		const lower = metricName.toLowerCase()
		if (/\b(error[._-]?rate|percentage|percent)\b/.test(lower)) return "percent"
		if (/[._](seconds|s)$/.test(lower) || /\b(duration[._]seconds)\b/.test(lower)) return "duration_s"
		if (/\b(duration|latency|response[._]time)\b/.test(lower)) return "duration_ms"
		if (/\b(bytes|memory|size)\b/.test(lower)) return "bytes"
	}
	if (metric === "rate") return "requests_per_sec"
	return "number"
}
