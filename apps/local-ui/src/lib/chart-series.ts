// Long (bucket, series, value) rows → the wide rows the shared line chart
// plots. Counts and rates are laid over the complete bucket timeline with
// zeros, so a monotone curve never interpolates across an empty stretch.

import { bucketTimeline } from "@maple/query-engine"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { ChartWindow } from "./time"

export interface SeriesPoint {
	readonly bucket: string
	readonly series: string
	readonly value: number
}

/**
 * `"zero"` for counts and rates: an empty bucket really is zero. `"sparse"`
 * for averages: an empty bucket is unknown, and the shared chart would draw
 * a missing value as 0, so those buckets are left out entirely.
 */
export type GapFill = "zero" | "sparse"

export type ChartRow = Record<string, string | number>

/** Pivot onto the window's buckets; points outside the window are dropped. */
export function pivotSeries(
	points: ReadonlyArray<SeriesPoint>,
	window: ChartWindow,
	fill: GapFill,
): ChartRow[] {
	const timeline = bucketTimeline(window.startMs, window.endMs, window.bucketSeconds)
	const seriesNames = [...new Set(points.map((point) => point.series))]
	const byBucket = new Map<number, ChartRow>()
	for (const bucket of timeline) {
		const row: ChartRow = { bucket }
		if (fill === "zero") for (const name of seriesNames) row[name] = 0
		byBucket.set(toEpochMs(bucket), row)
	}
	const touched = new Set<number>()
	for (const point of points) {
		const key = toEpochMs(point.bucket)
		const row = byBucket.get(key)
		if (!row) continue
		row[point.series] = point.value
		touched.add(key)
	}
	return [...byBucket.entries()]
		.filter(([key]) => (fill === "zero" ? seriesNames.length > 0 : touched.has(key)))
		.map(([, row]) => row)
}
