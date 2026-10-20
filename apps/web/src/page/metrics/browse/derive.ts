import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { MetricRow, SparklineMetricType } from "../shared"
import type { SparklinePoint } from "./model"

// Pure parts of the metric preview grid and its cards.

export const PAGE_SIZE = 24
/** Catalog rows fetched once; unique metrics are paginated client-side. */
export const CATALOG_LIMIT = 500
/** `MetricsTable`: rows per Load more, and the backend's cap (one extra row detects more). */
export const TABLE_PAGE_SIZE = 100
export const TABLE_MAX_LIMIT = 1000

export interface PreviewEntry {
	readonly metricName: string
	readonly metricType: string
	readonly metricUnit: string
	readonly metricDescription: string
	readonly serviceNames: ReadonlyArray<string>
}

export const entryKey = (metricName: string, metricType: string): string => `${metricName}::${metricType}`

/** `toEntries`: per-(metric, service) catalog rows collapsed into one grid entry per metric. */
export const toEntries = (rows: ReadonlyArray<MetricRow>): ReadonlyArray<PreviewEntry> => {
	const byMetric = new Map<string, PreviewEntry>()
	rows.forEach((row) => {
		const key = entryKey(row.metricName, row.metricType)
		const existing = byMetric.get(key)
		if (existing !== undefined) {
			if (row.serviceName !== "" && !existing.serviceNames.includes(row.serviceName)) {
				byMetric.set(key, { ...existing, serviceNames: [...existing.serviceNames, row.serviceName] })
			}
			return
		}
		byMetric.set(key, {
			metricName: row.metricName,
			metricType: row.metricType,
			metricUnit: row.metricUnit,
			metricDescription: row.metricDescription,
			serviceNames: row.serviceName === "" ? [] : [row.serviceName],
		})
	})
	return [...byMetric.values()]
}

/** The mounted `GridPage`s: `visiblePages` pages of `PAGE_SIZE` entries. */
export const gridPages = (
	entries: ReadonlyArray<PreviewEntry>,
	visiblePages: number,
): ReadonlyArray<ReadonlyArray<PreviewEntry>> =>
	Array.from(
		{ length: Math.ceil(Math.min(visiblePages * PAGE_SIZE, entries.length) / PAGE_SIZE) },
		(_, page) => entries.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
	)

export const namesOfType = (
	entries: ReadonlyArray<PreviewEntry>,
	metricType: string,
): ReadonlyArray<string> =>
	entries.filter((entry) => entry.metricType === metricType).map((entry) => entry.metricName)

/** `sparklineRows`: counters plot datapoints per interval, everything else the average. */
export const sparklineValues = (
	metricType: string,
	points: ReadonlyArray<SparklinePoint>,
): ReadonlyArray<number> =>
	points.map((point) => (metricType === "sum" ? point.dataPointCount : point.avgValue))

/**
 * One page's `getMetricSparklines` query for a metric type. Slots are stored by this key, so a
 * remounted grid reuses an answer it already has (the atom family's cache).
 */
export const sparklineRequest = (
	orgId: string,
	window: TimeWindow,
	metricType: SparklineMetricType,
	metricNames: ReadonlyArray<string>,
) => {
	const input = { metricType, metricNames, startTime: window.startTime, endTime: window.endTime }
	return { key: requestKey(orgId, "getMetricSparklines", { data: input }), input }
}
