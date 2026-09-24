import { Match, pipe } from "effect"

import { toEpochMs } from "./time-format"

// Imported, not re-exported straight through: the formatters below CALL these,
// and a bare `export … from` binds nothing in this module's scope.
import { formatDuration, formatNumber } from "@maple/domain/format"

export { formatDuration, formatNumber }

/**
 * Format a duration for an axis tick, at a precision derived from the tick spacing.
 *
 * `formatDuration` has fixed precision, so a deeply zoomed ruler stepping by 0.05 ms renders
 * "1.5ms" for three ticks in a row. Deriving the decimal count from the step guarantees
 * adjacent ticks are always distinguishable, whatever the zoom.
 *
 * The unit follows the *value* (µs below 1 ms, s at or above 1000 ms) while the precision
 * follows the *step*, so a 0.001 ms step still reads "1234μs" rather than "1.234000ms".
 */
export function formatDurationAtStep(ms: number, stepMs: number): string {
	if (!Number.isFinite(ms)) return "—"
	const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 1
	// Decimals needed to separate two ticks one step apart. The epsilon absorbs the float noise
	// in log10(0.001) = -3.0000000000000004, which would otherwise ask for one extra digit.
	const decimalsFor = (unitStep: number) => Math.max(0, -Math.floor(Math.log10(unitStep) + 1e-9))

	if (Math.abs(ms) < 1 && step < 1) {
		return `${(ms * 1000).toFixed(decimalsFor(step * 1000))}μs`
	}
	if (Math.abs(ms) < 1000) {
		return `${ms.toFixed(Math.min(3, decimalsFor(step)))}ms`
	}
	if (Math.abs(ms) < 60_000) {
		return `${(ms / 1000).toFixed(Math.min(3, decimalsFor(step / 1000)))}s`
	}
	return `${(ms / 60_000).toFixed(Math.min(2, decimalsFor(step / 60_000)))}min`
}

// Two byte formatters, not one with a `base` option: the choice between them is
// semantic, not cosmetic. Memory, disk and network sizes are binary; storage a
// customer is billed for is quoted in decimal units, and quietly showing
// "976.6 KB" where an invoice says "1.0 MB" is a support ticket.

const BINARY_UNITS = ["B", "KB", "MB", "GB", "TB"] as const
const DECIMAL_UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/** Binary (1024-based) byte size — memory, disk, page weight. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
		value /= 1024
		unit += 1
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${BINARY_UNITS[unit]}`
}

/** Decimal (1000-based) byte size — warehouse storage and anything billed. */
export function formatStorageBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
	let value = bytes
	let unit = 0
	while (value >= 1000 && unit < DECIMAL_UNITS.length - 1) {
		value /= 1000
		unit += 1
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${DECIMAL_UNITS[unit]}`
}

/** Binary (1024-based) throughput. */
export function formatBytesPerSecond(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes === 0) return "0 B/s"
	const units = ["B/s", "KB/s", "MB/s", "GB/s"]
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit++
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * Format a 0–1 fraction as a utilization percentage. Distinct from
 * `formatErrorRate`: this floors to "0%" below 0.05% and drops to whole numbers
 * past 10%, which suits gauges and resource bars. Error rates want the opposite
 * (a visible "<0.01%" so a rare failure never reads as zero).
 */
export function formatPercent(fraction: number): string {
	if (!Number.isFinite(fraction)) return "—"
	const pct = fraction * 100
	if (pct < 0.05) return "0%"
	if (pct < 10) return `${pct.toFixed(1)}%`
	return `${pct.toFixed(0)}%`
}

/** Two-decimal load average. */
export function formatLoad(load: number): string {
	if (!Number.isFinite(load)) return "—"
	return load.toFixed(2)
}

/** Coarse uptime: minutes, then hours, then `"3d 4h"`. */
export function formatUptime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "—"
	const m = Math.floor(seconds / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h`
	const d = Math.floor(h / 24)
	return `${d}d ${h % 24}h`
}

/**
 * Format a latency value in milliseconds to a human-readable string.
 */
export function formatLatency(ms: number): string {
	if (ms == null || Number.isNaN(ms)) {
		return "-"
	}
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}μs`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(2)}s`
	}
	if (ms < 3_600_000) {
		return `${(ms / 60_000).toFixed(1)}min`
	}
	return `${(ms / 3_600_000).toFixed(1)}h`
}

/**
 * Format an error rate (0–1 ratio) as a percentage string.
 */
export function formatErrorRate(rate: number): string {
	const pct = rate * 100
	if (pct === 0) {
		return "0%"
	}
	if (pct > 0 && pct < 0.01) return "<0.01%"
	if (pct < 1) {
		return `${pct.toFixed(2)}%`
	}
	return `${pct.toFixed(1)}%`
}

/**
 * Infer the bucket interval in seconds from consecutive data points.
 * Expects data with a `bucket` string timestamp field.
 */
export function inferBucketSeconds(data: ReadonlyArray<{ bucket: string }>): number | undefined {
	if (data.length < 2) return undefined
	const t0 = toEpochMs(data[0].bucket)
	const t1 = toEpochMs(data[1].bucket)
	const diffMs = t1 - t0
	if (diffMs <= 0 || Number.isNaN(diffMs)) return undefined
	return diffMs / 1000
}

/**
 * Parse a bucket value to a millisecond timestamp.
 *
 * Goes through `toEpochMs` so tz-less warehouse buckets are read as UTC. Without
 * it, `incomplete-buckets` compared a locally-parsed bucket against `Date.now()`
 * and mis-placed the trailing dashed segment by the browser's UTC offset.
 */
export function parseBucketMs(value: unknown): number | null {
	if (typeof value !== "string") return null
	const parsed = toEpochMs(value)
	return Number.isNaN(parsed) ? null : parsed
}

/**
 * Infer the total time range in milliseconds from an array of data points with a `bucket` key.
 */
export function inferRangeMs(data: ReadonlyArray<Record<string, unknown>>): number {
	const bucketTimes = data
		.map((row) => parseBucketMs(row.bucket))
		.filter((value): value is number => value != null)

	if (bucketTimes.length < 2) return 0
	return Math.max(...bucketTimes) - Math.min(...bucketTimes)
}

/**
 * Format a bucket timestamp label that adapts based on the overall time range:
 * - >= 24h with daily buckets: "Feb 14"
 * - >= 24h with sub-day buckets: "Feb 14, 02:00 PM"
 * - 30min - 24h: "02:00 PM"
 * - <= 30min: "02:00:30 PM"
 */
export function formatBucketLabel(
	value: unknown,
	context: { rangeMs: number; bucketSeconds: number | undefined; timeZone?: string },
	mode: "tick" | "tooltip",
): string {
	if (typeof value !== "string") return ""

	// Normalize first: warehouse buckets carry no timezone marker, so parsing them
	// raw shifted every chart's axis labels by the browser's UTC offset.
	const date = new Date(toEpochMs(value))
	if (Number.isNaN(date.getTime())) return value

	const includeDate = context.rangeMs >= 24 * 60 * 60 * 1000 || (context.bucketSeconds ?? 0) >= 24 * 60 * 60
	const includeSeconds = context.rangeMs <= 30 * 60 * 1000 && !includeDate
	// The viewer's selected zone when the chart sits under a `PlotTimeZoneProvider`;
	// the browser's otherwise.
	const timeZone = context.timeZone

	if (mode === "tooltip") {
		// The tooltip header always carries the full date — ticks stay terse, but a
		// hovered point should never make the reader work out which day it was.
		return date.toLocaleString(undefined, {
			timeZone,
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: includeSeconds ? "2-digit" : undefined,
		})
	}

	if (includeDate) {
		if ((context.bucketSeconds ?? 0) >= 24 * 60 * 60) {
			return date.toLocaleDateString(undefined, { timeZone, month: "short", day: "numeric" })
		}
		return date
			.toLocaleString(undefined, {
				timeZone,
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
			.replace(/ 24:/, " 00:")
	}

	return date
		.toLocaleTimeString(undefined, {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			second: includeSeconds ? "2-digit" : undefined,
		})
		.replace(/^24:/, "00:")
}

const bucketLabelMap: Record<number, string> = {
	60: "/min",
	300: "/5min",
	900: "/15min",
	3600: "/h",
	14400: "/4h",
	86400: "/d",
} satisfies Record<number, string>

/**
 * Map bucket interval seconds to a human-readable rate suffix.
 */
export function bucketIntervalLabel(seconds: number | undefined): string {
	if (seconds == null) return ""
	return bucketLabelMap[seconds] ?? ""
}

/**
 * Format a throughput value with a rate suffix for chart axes.
 */
export function formatThroughput(value: number, suffix: string): string {
	return `${formatNumber(value)}${suffix}`
}

/** Decimals a percentage may grow to before the number stops being readable. */
const PERCENT_MAX_DIGITS = 6
const PERCENT_SMALLEST = 10 ** -PERCENT_MAX_DIGITS

/**
 * A percentage at one decimal — but never rounded down to a flat `0.0%`.
 *
 * `toFixed(1)` turns everything under 0.05 into zero, so a chart of a
 * sub-0.05% rate came out as a column of `0.0%` ticks with a `0.0%` readout
 * over it: the axis said the series was flat zero when it was not. Below that
 * floor the decimals grow until the first significant digit shows, and past
 * the cap the value is reported as smaller than the smallest thing this can
 * write. At or above the floor — and at exactly zero — the output is what it
 * always was.
 *
 * The third percentage rule in this file, and deliberately so: `formatPercent`
 * floors to `0%` because a utilization gauge reading `0.003%` is noise, and
 * `formatErrorRate` is fixed to two decimals because an error rate is read
 * against other error rates. This one formats a **chart axis**, where the
 * whole job is the magnitude and rounding it away is the failure. It borrows
 * `formatErrorRate`'s `<` idiom for the bottom of its range.
 */
const percentText = (pct: number): string => {
	const abs = Math.abs(pct)
	if (abs === 0 || abs >= 0.05) return `${pct.toFixed(1)}%`
	const rounded = Number(pct.toFixed(Math.min(PERCENT_MAX_DIGITS, Math.ceil(-Math.log10(abs)) + 1)))
	if (rounded !== 0) return `${rounded}%`
	return pct < 0 ? `>-${PERCENT_SMALLEST}%` : `<${PERCENT_SMALLEST}%`
}

/**
 * Format a numeric value according to a unit type.
 * Used by chart Y-axis ticks, tooltips, and stat widgets.
 */
export const formatValueByUnit: (num: number, unit?: string) => string = (num, unit) =>
	pipe(
		Match.value(unit),
		Match.when("percent", () => percentText(num * 100)),
		// For sources that already report 0–100 (PlanetScale's `*_util_percentages`, NATS varz
		// `cpu`, most Prometheus exporters). Without this they had to borrow `percent` and render
		// 100× high, or drop the `%` entirely by falling back to `number`.
		Match.when("percent_100", () => percentText(num)),
		Match.when("duration_ms", () => formatDuration(num)),
		Match.when("duration_us", () => formatDuration(num / 1000)),
		Match.when("duration_s", () => formatDuration(num * 1000)),
		Match.when("duration_ns", () => formatDuration(num / 1_000_000)),
		Match.when("requests_per_sec", () => `${formatNumber(num)}/s`),
		// Decimal, deliberately: widgets with a `bytes` unit live in saved user
		// dashboards, and switching them to a 1024 base would silently rewrite
		// every one of those readouts (1_000_000 → "976.6 KB" instead of "1.0 MB").
		Match.when("bytes", () => formatStorageBytes(num)),
		Match.orElse(() => formatNumber(num)),
	)
