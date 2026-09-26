import { formatDurationFromMs, formatNumber, formatPercent } from "./format"
import type { QueryDataUnit } from "@maple/domain"

/** The `HH:mm:ss` of a bucket timestamp, which is all a table row needs. */
export function formatBucket(bucket: string): string {
	const match = bucket.match(/T(\d{2}:\d{2}:\d{2})/)
	return match ? match[1] : bucket.slice(11, 19)
}

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
