import { type ChartWindow, chartWindow, parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { isCounter } from "../../lib/units"
import type { MetricEntry } from "./catalog"
import type { SparklineGroup, SparklinePoint } from "./fetch"
import { Schema } from "effect"

// Pure parts of the Metrics page.

/** `sparklineWindow`: the range clipped to when the oldest listed metric started. */
export const sparklineWindow = (entries: ReadonlyArray<MetricEntry>, bounds: TimeBounds, nowMs: number): ChartWindow => {
	const firstSeen = entries.reduce<number | null>((earliest, entry) => {
		const ms = parseClickHouseDateTime(entry.firstSeen)
		return ms !== null && (earliest === null || ms < earliest) ? ms : earliest
	}, null)
	return chartWindow(bounds, firstSeen, nowMs)
}

/** The sparkline groups: metric names by type, types sorted. */
export const sparklineGroups = (entries: ReadonlyArray<MetricEntry>): ReadonlyArray<SparklineGroup> => {
	const byType = new Map<string, Array<string>>()
	entries.forEach((entry) => {
		const names = byType.get(entry.metricType)
		if (names) names.push(entry.metricName)
		else byType.set(entry.metricType, [entry.metricName])
	})
	return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/**
 * `previewValues`: counters preview their rise per bucket (clamped at resets), the rate's shape;
 * everything else its average.
 */
export const previewValues = (
	entry: Pick<MetricEntry, "metricType" | "isMonotonic">,
	points: ReadonlyArray<SparklinePoint>,
): ReadonlyArray<number> => {
	if (!isCounter(entry)) return points.map((point) => point.avgValue)
	return points.slice(1).map((point, index) => Math.max(0, point.avgValue - (points[index]?.avgValue ?? 0)))
}

/** `StatSparkline`'s values: non-finite readings draw as 0. */
export const sparklineValues = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
	values.map((value) => (Number.isFinite(value) ? value : 0))

/** `columnsFor`: the grid's columns for the scroll container's measured width. */
export const columnsFor = (width: number): number => {
	if (width >= 1000) return 3
	if (width >= 560) return 2
	return 1
}

/** Card height plus the grid gap, the virtualizer's row estimate. */
export const CARD_ROW_HEIGHT = 124 + 12
const ROW_OVERSCAN = 4

export const GridViewport = Schema.Struct({ width: Schema.Number, height: Schema.Number, scrollTop: Schema.Number })
export type GridViewport = typeof GridViewport.Type

/** `useVirtualizer` (fixed rows, overscan 4): the row indexes to draw. Unmeasured, the first rows. */
export const visibleRows = (rowCount: number, viewport: GridViewport): ReadonlyArray<number> => {
	if (rowCount === 0) return []
	const lastIndex = rowCount - 1
	const start = Math.min(lastIndex, Math.floor(viewport.scrollTop / CARD_ROW_HEIGHT))
	const end = Math.min(lastIndex, Math.max(start, Math.ceil((viewport.scrollTop + viewport.height) / CARD_ROW_HEIGHT) - 1))
	const from = Math.max(start - ROW_OVERSCAN, 0)
	const to = Math.min(end + ROW_OVERSCAN, lastIndex)
	return Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
}
