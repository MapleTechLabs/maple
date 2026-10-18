// Shared helpers for the infra detail charts (host + k8s). The two chart files
// keep their own <ChartView> (different units, container chrome, heights) but
// share the row→series transform, grid/empty conventions, and the unit-aware
// value formatting used by tooltips, legend chips, and axes. Series colors come
// from `resolveSeriesColors` — a host/pod/zone keeps its color across windows.

import { bucketDate } from "@maple/ui/components/plot"
import { formatTimeInTimezone } from "@/lib/timezone-format"
import { UNNAMED_SERIES_KEY } from "./chart-units"

export {
	chartBucketSeconds,
	formatSeconds,
	formatValueWithUnit,
	UNNAMED_SERIES_KEY,
	type ChartUnit,
} from "./chart-units"

export interface TransformedPoint extends Record<string, string | number | Date> {
	bucket: string
	/** The bucket's axis label. Charts on a categorical axis plot this. */
	time: string
	/**
	 * The bucket as an instant, for charts on a time axis. Precomputed once here
	 * because a scale accessor runs per datum per layout pass, and because the
	 * warehouse spells buckets without a timezone — `toEpochMs` reads them as
	 * UTC, where a bare `new Date(bucket)` would read them as local time.
	 */
	date: Date
}

/** Axis label for a bucket timestamp ("14:35"), in `timeZone` or the browser's. */
export function isoToLabel(iso: string, timeZone?: string): string {
	return formatTimeInTimezone(iso, { timeZone: timeZone ?? "" })
}

/** Pivot long-form `{bucket, attributeValue, value}` rows into per-bucket points keyed by series. */
export function transformRows(
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>,
	labeler: (iso: string) => string = isoToLabel,
): { data: TransformedPoint[]; series: string[] } {
	const seriesSet = new Set<string>()
	const byBucket = new Map<string, TransformedPoint>()
	for (const row of rows) {
		const series = row.attributeValue || UNNAMED_SERIES_KEY
		seriesSet.add(series)
		const existing: TransformedPoint = byBucket.get(row.bucket) ?? {
			bucket: row.bucket,
			time: labeler(row.bucket),
			date: bucketDate(row.bucket),
		}
		existing[series] = row.value
		byBucket.set(row.bucket, existing)
	}
	const data = Array.from(byBucket.values()).toSorted((a, b) => a.bucket.localeCompare(b.bucket))
	return { data, series: [...seriesSet] }
}
