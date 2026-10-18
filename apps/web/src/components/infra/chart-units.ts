// Units and value formatting of the infra charts, React-free (no timezone atoms).

import {
	EMPTY_VALUE,
	formatBytes,
	formatBytesPerSecond,
	formatLatency,
	formatLoad,
	formatPercent,
	formatRate,
	formatThroughput,
} from "@maple/ui/lib/format"

/**
 * Bucket width for the timeseries charts: aim for ~100 points, floored at the
 * poller's 5-minute granularity and rounded to whole 5-minute steps.
 */
export function chartBucketSeconds(startTime: string, endTime: string): number {
	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	const windowSeconds = Math.max((endMs - startMs) / 1000, 300)
	return Math.max(300, Math.ceil(windowSeconds / 100 / 300) * 300)
}

/** Every value unit an infra chart can carry. Drives unit-aware formatting. */
export type ChartUnit =
	| "percent"
	| "cores"
	| "seconds"
	| "load"
	| "bytes_per_second"
	| "bytes"
	// Service-side units, so a span metric can share a strip stack with a
	// kubeletstats gauge. `seconds` cannot stand in for latency: it rounds to
	// whole seconds and renders anything at or below zero as an em dash.
	| "milliseconds"
	| "rate"
	// A quantity: per-bucket event counts (requests, invocations) or levels (instances,
	// connections), compact like "1.2K" and fractional below one.
	| "count"

/** Compact, human duration ("45s", "12m", "3h 20m", "2d 4h"). */
export function formatSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return EMPTY_VALUE
	if (seconds < 60) return `${Math.round(seconds)}s`
	const m = Math.floor(seconds / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return `${d}d ${h % 24}h`
}

/**
 * Format a value WITH its unit so a tooltip/legend reads "9.5%", "0.067 cores",
 * "12 MB/s" — never a bare, ambiguous number. This is the single place that
 * decides how each unit renders.
 */
export function formatValueWithUnit(value: number, unit: ChartUnit): string {
	if (!Number.isFinite(value)) return EMPTY_VALUE
	switch (unit) {
		case "percent":
			return formatPercent(value)
		case "cores":
			// A sidecar idles at a fraction of a millicore, which three decimals round to zero.
			return `${value.toLocaleString(undefined, Math.abs(value) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 3 })} cores`
		case "seconds":
			return formatSeconds(value)
		case "load":
			return formatLoad(value)
		case "bytes_per_second":
			return formatBytesPerSecond(value)
		case "bytes":
			return formatBytes(value)
		case "milliseconds":
			return formatLatency(value)
		case "rate":
			return formatThroughput(value, "/s")
		case "count":
			return formatRate(value)
	}
}

/**
 * Series key for a gauge with no group-by attribute (a single line). Charts
 * swap this placeholder for the metric's human `seriesLabel` in legends and
 * tooltips so it never surfaces as a bare "value".
 */
export const UNNAMED_SERIES_KEY = "value"
