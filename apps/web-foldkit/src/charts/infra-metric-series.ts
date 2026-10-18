import { bucketDate } from "@maple/ui/components/plot/bucket-axis"
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
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

// copied: the React-free half of apps/web/src/components/infra/chart-utils.ts (the module imports
// `@/lib/timezone-format`), which `InfraMetricChart` reads: units, the long-form pivot and colours.

export type ChartUnit =
	| "percent"
	| "cores"
	| "seconds"
	| "load"
	| "bytes_per_second"
	| "bytes"
	| "milliseconds"
	| "rate"
	| "count"

export const UNNAMED_SERIES_KEY = "value"

/** `chartBucketSeconds`: about 100 points, floored at the pollers' 5 minutes, whole 5-minute steps. */
export const chartBucketSeconds = (startTime: string, endTime: string): number => {
	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	const windowSeconds = Math.max((endMs - startMs) / 1000, 300)
	return Math.max(300, Math.ceil(windowSeconds / 100 / 300) * 300)
}

/** `formatSeconds`: "45s", "12m", "3h 20m", "2d 4h". */
export const formatSeconds = (seconds: number): string => {
	if (!Number.isFinite(seconds) || seconds <= 0) return EMPTY_VALUE
	if (seconds < 60) return `${Math.round(seconds)}s`
	const m = Math.floor(seconds / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return `${d}d ${h % 24}h`
}

/** `formatValueWithUnit`: tooltips, legends and header chips print the unit. */
export const formatValueWithUnit = (value: number, unit: ChartUnit): string => {
	if (!Number.isFinite(value)) return EMPTY_VALUE
	switch (unit) {
		case "percent":
			return formatPercent(value)
		case "cores":
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

export type InfraPoint = Readonly<Record<string, string | number | Date>> & {
	readonly bucket: string
	readonly date: Date
}

export type LongRow = Readonly<{ bucket: string; attributeValue: string; value: number }>

/** `transformRows`: long-form rows pivoted into one point per bucket, keyed by series. */
export const transformRows = (
	rows: ReadonlyArray<LongRow>,
): { readonly data: ReadonlyArray<InfraPoint>; readonly series: ReadonlyArray<string> } => {
	const series = [...new Set(rows.map((row) => row.attributeValue || UNNAMED_SERIES_KEY))]
	const byBucket = rows.reduce((buckets, row) => {
		const name = row.attributeValue || UNNAMED_SERIES_KEY
		const existing = buckets.get(row.bucket) ?? { bucket: row.bucket, date: bucketDate(row.bucket) }
		return buckets.set(row.bucket, { ...existing, [name]: row.value })
	}, new Map<string, InfraPoint>())
	const data = [...byBucket.values()].toSorted((a, b) => a.bucket.localeCompare(b.bucket))
	return { data, series }
}

/** Every series' colour token: semantic names first, then the stable identity hash. */
export const seriesColorTokens = (series: ReadonlyArray<string>): ReadonlyMap<string, string> =>
	resolveSeriesColors(series)

/** Tokens `resolveSeriesColors` and the chart chrome can name, resolved once per theme by the page. */
export const INFRA_CHART_TOKENS: ReadonlyArray<string> = [
	"--border",
	"--background",
	"--destructive",
	"--chart-1",
	"--chart-p50",
	"--chart-p95",
	"--chart-p99",
	"--severity-info",
	"--severity-warn",
	"--severity-error",
	"--muted-foreground",
	"--color-severity-trace",
	"--color-severity-debug",
	"--color-severity-info",
	"--color-severity-warn",
	"--color-severity-error",
	"--color-severity-fatal",
	"--color-muted-foreground",
]

/** Buckets with no finite value for any series plot nothing, so they count as empty too. */
export const hasPlottableValue = (rows: ReadonlyArray<LongRow>): boolean =>
	rows.some((row) => Number.isFinite(row.value))
