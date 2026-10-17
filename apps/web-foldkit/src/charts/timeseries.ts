import {
	formatBucketLabel,
	formatValueByUnit,
	inferBucketSeconds,
	inferRangeMs,
	parseBucketMs,
} from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { DEFAULT_TOKEN_FALLBACK } from "@maple/ui/lib/colors"
import { hasOnlyIntegerValues } from "@maple/ui/components/charts/_shared/sparse-series"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import {
	integerTickValues,
	linearYDomain,
	NICE_TICK_COUNT,
	niceLinearDomain,
	zonedTimeScale,
} from "@maple/ui/components/plot/plot-scales"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import {
	asFiniteNumber,
	rowsDomainMs,
	type TimeseriesAxisContext,
	type TimeseriesRow,
} from "./timeseries-rows"

// The React-free half of `Timeseries` (packages/ui/src/components/plot/timeseries.tsx): row
// normalisation, series keys and colour tokens, and the shared x and y axes. Copied, as that
// module also holds the React model hook and frame.

export const HARD_SERIES_LIMIT = 60
export const SERIES_FALLBACK_COLOR = DEFAULT_TOKEN_FALLBACK

export interface SeriesDefinition {
	readonly rawKey: string
	readonly chartKey: string
}

/** `normaliseTimeseriesRows`'s series discovery: first-seen order across all rows, `s1..sN` keys. */
export const seriesDefinitionsOf = (data: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
	const rawKeys = [
		...new Set(
			data.flatMap((row) => Object.keys(row).filter((key) => key !== "bucket" && key !== "partial")),
		),
	]
	return {
		definitions: rawKeys
			.slice(0, HARD_SERIES_LIMIT)
			.map((rawKey, index): SeriesDefinition => ({ rawKey, chartKey: `s${index + 1}` })),
		totalSeriesCount: rawKeys.length,
	}
}

/** The rows of `normaliseTimeseriesRows`, values keyed by chart key; unparseable buckets dropped. */
export const normaliseRows = (
	data: ReadonlyArray<Readonly<Record<string, unknown>>>,
	definitions: ReadonlyArray<SeriesDefinition>,
): Array<TimeseriesRow> =>
	data.flatMap((row): Array<TimeseriesRow> => {
		const bucket = typeof row.bucket === "string" ? row.bucket : ""
		const epochMs = parseBucketMs(bucket)
		if (epochMs == null) return []
		const next: TimeseriesRow = { bucket, date: new Date(epochMs) }
		if (row.partial === true) next.partial = true
		definitions.forEach((definition) => {
			next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
		})
		return [next]
	})

/** `scaleTimeseriesRates`: rates are stored per bucket and displayed per second. */
export const scaleRates = (
	rows: Array<TimeseriesRow>,
	keys: ReadonlyArray<string>,
	unit: string | undefined,
	bucketSeconds: number | undefined,
): Array<TimeseriesRow> => {
	if (unit !== "requests_per_sec" || !bucketSeconds) return rows
	return rows.map((row) => {
		const next: TimeseriesRow = { bucket: row.bucket, date: row.date }
		if (row.partial) next.partial = true
		keys.forEach((key) => {
			next[key] = asFiniteNumber(row[key]) / bucketSeconds
		})
		return next
	})
}

/** `resolveSeriesColors` by chart key: tokens (`var(--chart-1)`) or literals. */
export const seriesColorTokens = (
	definitions: ReadonlyArray<SeriesDefinition>,
): ReadonlyMap<string, string> => {
	const byRawKey = resolveSeriesColors(definitions.map((definition) => definition.rawKey))
	return new Map(
		definitions.map((definition) => [
			definition.chartKey,
			byRawKey.get(definition.rawKey) ?? SERIES_FALLBACK_COLOR,
		]),
	)
}

export const axisContextOf = (
	rows: ReadonlyArray<TimeseriesRow>,
	timeZone: string | undefined,
): TimeseriesAxisContext => ({
	rangeMs: inferRangeMs(rows),
	bucketSeconds: inferBucketSeconds(rows),
	domainMs: rowsDomainMs(rows),
	timeZone,
})

export const bucketSecondsOf = (rows: ReadonlyArray<TimeseriesRow>) => inferBucketSeconds(rows)

const NOMINAL_PLOT_WIDTH = 600
const HALF_CHAR_PX = 2.8
const MAX_EDGE_FRACTION = 0.2

/** `edgeTickAnchor`: keeps the end tick labels inside the plot instead of overhanging it. */
const edgeTickAnchor = (axisContext: TimeseriesAxisContext) => {
	const domain = axisContext.domainMs
	if (!domain) return undefined
	const spanMs = domain[1] - domain[0]
	if (spanMs <= 0) return undefined
	return ({ value }: { value: Date }): "start" | "middle" | "end" => {
		const at = value.getTime()
		if (!Number.isFinite(at)) return "middle"
		const label = formatBucketLabel(value.toISOString(), axisContext, "tick")
		const fraction = Math.min(MAX_EDGE_FRACTION, (label.length * HALF_CHAR_PX) / NOMINAL_PLOT_WIDTH)
		const slackMs = spanMs * fraction
		if (at >= domain[1] - slackMs) return "end"
		if (at <= domain[0] + slackMs) return "start"
		return "middle"
	}
}

/** `timeseriesXAxis`: a zoned time scale over `row.date`, round clock ticks 104px apart. */
export const timeseriesXAxis = (axisContext: TimeseriesAxisContext) => ({
	scale: zonedTimeScale(axisContext.timeZone),
	axis: {
		line: false,
		ticks: {
			size: 0,
			padding: 8,
			spacing: 104,
			format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
		},
		tickLabels: { thin: { minGap: 12 }, anchor: edgeTickAnchor(axisContext) },
	},
})

export interface YAxisOptions {
	readonly rows: ReadonlyArray<Record<string, unknown>>
	readonly visibleKeys: ReadonlyArray<string>
	readonly unit?: string | undefined
	readonly stacked?: boolean
	readonly softMin?: number
	readonly softMax?: number
	/** Tick labels; defaults to `formatValueByUnit(value, unit)`. */
	readonly format?: (value: number) => string
}

/** `timeseriesYAxis`, linear, without log scale or thresholds. */
export const timeseriesYAxis = (options: YAxisOptions) => {
	const dataDomain = linearYDomain({
		rows: options.rows,
		keys: options.visibleKeys,
		stacked: options.stacked,
		softMin: options.softMin,
		softMax: options.softMax,
		fitYAxisToData: false,
	})
	const domain: [number, number] = niceLinearDomain(dataDomain)
	const integerOnly =
		hasOnlyIntegerValues(options.rows, options.visibleKeys) &&
		options.unit == null &&
		options.format == null
	return {
		domain,
		y: {
			grid: DASHED_Y_GRID,
			scale: scaleLinear().domain(domain),
			nice: NICE_TICK_COUNT,
			axis: {
				line: false,
				ticks: {
					size: 0,
					padding: 6,
					values: integerOnly ? integerTickValues(domain) : undefined,
					format: options.format ?? ((value: number) => formatValueByUnit(value, options.unit)),
				},
			},
		},
	}
}
