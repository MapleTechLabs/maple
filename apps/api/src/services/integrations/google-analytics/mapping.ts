/**
 * Pure mapping from a decoded GA4 `runReport` response to flat series points.
 *
 * Deliberately does NOT produce metric rows: what gets written depends on the reconciliation
 * ledger (see `reconcile.ts`), so this stage stops at "here is the value GA4 currently reports
 * for this series in this hour" and leaves the delta arithmetic downstream.
 *
 * Two things are resolved here that the rest of the pipeline then never has to think about:
 * - `dateHour` is in the property's reporting timezone, so it is converted to a UTC instant.
 * - The breakdown dimension is capped and its tail folded, so `Attributes` — which sits in the
 *   metrics tables' sorting key — stays bounded.
 */
import type { GoogleAnalyticsRunReportResponse } from "../GoogleAnalyticsApi"
import { foldTail, OTHER_BUCKET } from "../shared/cardinality"
import type { GaDatasetDef, GaMetricDef } from "./datasets"
import { dateHourToUtcMs } from "./timezone"

/** GA4's own overflow bucket, folded into ours so the two do not appear as separate series. */
const GA_OTHER_ROW = "(other)"

export interface GaSeriesPoint {
	/** UTC epoch ms of the hour bucket's start. */
	readonly bucketMs: number
	readonly metric: GaMetricDef
	readonly attributes: Record<string, string>
	readonly value: number
}

/**
 * Stable identity for a series within a (property, dataset, bucket), used as the ledger key.
 * Attribute order is normalized so a key never depends on object insertion order.
 */
export const seriesKey = (metricName: string, attributes: Record<string, string>): string => {
	const entries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return entries.length === 0
		? metricName
		: `${metricName} ${entries.map(([key, value]) => `${key}=${value}`).join(" ")}`
}

const numberOf = (raw: string | undefined): number => {
	if (raw === undefined || raw === "") return 0
	const parsed = Number(raw)
	// GA4 returns metric values as strings; a non-numeric one is a contract break, and counting
	// it as zero is safer than letting NaN reach the warehouse and poison a bucket's sum.
	return Number.isFinite(parsed) ? parsed : 0
}

const truncate = (value: string, max: number | undefined): string =>
	max !== undefined && value.length > max ? value.slice(0, max) : value

const indexOfHeader = (
	headers: ReadonlyArray<{ readonly name?: string }> | undefined,
	name: string,
): number => (headers ?? []).findIndex((header) => header.name === name)

/**
 * Map one report. Rows whose `dateHour` cannot be placed on the timeline (malformed, or an
 * unknown property timezone) are dropped rather than guessed at — a missing point is recoverable
 * on the next reconcile pass, a misplaced one is not.
 */
export const mapReport = (options: {
	readonly dataset: GaDatasetDef
	readonly response: GoogleAnalyticsRunReportResponse
	readonly timeZone: string
}): ReadonlyArray<GaSeriesPoint> => {
	const { dataset, response, timeZone } = options
	const rows = response.rows ?? []
	if (rows.length === 0) return []

	const hourIndex = indexOfHeader(response.dimensionHeaders, "dateHour")
	if (hourIndex < 0) return []

	const breakdown = dataset.breakdown
	const breakdownIndex = breakdown === null ? -1 : indexOfHeader(response.dimensionHeaders, breakdown.dimension)
	// The report echoes back the dimensions we asked for; a response missing the breakdown column
	// is not one we can attribute, so emitting it unbroken would double-count against `traffic`.
	if (breakdown !== null && breakdownIndex < 0) return []

	const metricIndexes = dataset.metrics.map((metric) => ({
		metric,
		index: indexOfHeader(response.metricHeaders, metric.ga),
	}))

	const dimensionValue = (row: (typeof rows)[number], index: number): string =>
		row.dimensionValues?.[index]?.value ?? ""

	// Pass 1: rank the breakdown values across the whole window, so the surviving top-N is stable
	// for every bucket in it. Ranking per bucket instead would churn the series set hour to hour.
	let fold: (key: string) => string = (key) => key
	if (breakdown !== null) {
		const rankIndex = indexOfHeader(response.metricHeaders, breakdown.rankBy)
		const weights = new Map<string, number>()
		for (const row of rows) {
			const raw = dimensionValue(row, breakdownIndex)
			if (raw === "" || raw === GA_OTHER_ROW) continue
			const value = truncate(raw, breakdown.maxValueLength)
			const weight = rankIndex < 0 ? 1 : numberOf(row.metricValues?.[rankIndex]?.value)
			weights.set(value, (weights.get(value) ?? 0) + weight)
		}
		fold = foldTail(weights, breakdown.maxValues)
	}

	/** A row's metric attributes: the folded breakdown value, or none for the totals dataset. */
	const attributesFor = (row: (typeof rows)[number]): GaSeriesPoint["attributes"] => {
		if (breakdown === null) return {}
		const raw = dimensionValue(row, breakdownIndex)
		const folded =
			raw === "" || raw === GA_OTHER_ROW ? OTHER_BUCKET : fold(truncate(raw, breakdown.maxValueLength))
		return { [breakdown.attributeKey]: folded }
	}

	// Pass 2: accumulate, because folding merges many raw values into one `other` series and the
	// same (bucket, series) must arrive at the ledger exactly once.
	const accumulated = new Map<string, GaSeriesPoint>()
	for (const row of rows) {
		const bucketMs = dateHourToUtcMs(dimensionValue(row, hourIndex), timeZone)
		if (bucketMs === null) continue

		const attributes = attributesFor(row)

		for (const { metric, index } of metricIndexes) {
			if (index < 0) continue
			const value = numberOf(row.metricValues?.[index]?.value)
			const key = `${bucketMs} ${seriesKey(metric.metric, attributes)}`
			const existing = accumulated.get(key)
			if (existing === undefined) {
				accumulated.set(key, { bucketMs, metric, attributes, value })
			} else {
				accumulated.set(key, { ...existing, value: existing.value + value })
			}
		}
	}

	return [...accumulated.values()]
}
