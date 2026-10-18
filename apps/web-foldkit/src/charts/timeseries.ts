import { formatValueByUnit, inferBucketSeconds, inferRangeMs, parseBucketMs } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { DEFAULT_TOKEN_FALLBACK } from "@maple/ui/lib/colors"
import { hasOnlyIntegerValues } from "@maple/ui/components/charts/_shared/sparse-series"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import {
	integerTickValues,
	linearYDomain,
	logYDomain,
	logYScale,
	NICE_TICK_COUNT,
	niceLinearDomain,
} from "@maple/ui/components/plot/plot-scales"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import {
	asFiniteNumber,
	rowsDomainMs,
	type TimeseriesAxisContext,
	type TimeseriesRow,
} from "./timeseries-rows"
import { resolveColor, type ThemeColors } from "./theme-colors"

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

/** What a hoisting `TimeseriesLegend` hands the tile header: every series, colour resolved. */
export const hoistedSeries = (
	data: ReadonlyArray<Readonly<Record<string, unknown>>>,
	theme: ThemeColors,
): ReadonlyArray<{ readonly key: string; readonly label: string; readonly color: string }> => {
	const { definitions } = seriesDefinitionsOf(data)
	const tokens = seriesColorTokens(definitions)
	return definitions.map((definition) => ({
		key: definition.chartKey,
		label: definition.rawKey,
		color: resolveColor(
			theme,
			tokens.get(definition.chartKey) ?? SERIES_FALLBACK_COLOR,
			SERIES_FALLBACK_COLOR,
		),
	}))
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

export interface YAxisOptions {
	readonly rows: ReadonlyArray<Record<string, unknown>>
	readonly visibleKeys: ReadonlyArray<string>
	readonly unit?: string | undefined
	readonly stacked?: boolean
	readonly softMin?: number
	readonly softMax?: number
	/** Tick labels; defaults to `formatValueByUnit(value, unit)`. */
	readonly format?: (value: number) => string
	readonly logScale?: boolean
	readonly fitYAxisToData?: boolean
	readonly thresholds?: ReadonlyArray<{ readonly value: number }>
}

/** `timeseriesYAxis`: the shared y axis, domain included (log axes pin their own floor at 1). */
export const timeseriesYAxis = (options: YAxisOptions) => {
	const logScale = options.logScale === true
	const dataDomain = linearYDomain({
		rows: options.rows,
		keys: options.visibleKeys,
		stacked: options.stacked,
		softMin: options.softMin,
		softMax: options.softMax,
		fitYAxisToData: options.fitYAxisToData === true && options.softMin == null && !logScale,
		thresholds: options.thresholds === undefined ? undefined : [...options.thresholds],
	})
	const domain: [number, number] = logScale ? logYDomain(dataDomain[1]) : niceLinearDomain(dataDomain)
	const integerOnly =
		hasOnlyIntegerValues(options.rows, options.visibleKeys) &&
		options.unit == null &&
		options.format == null
	return {
		domain,
		y: {
			grid: DASHED_Y_GRID,
			scale: logScale ? logYScale(dataDomain[1]) : scaleLinear().domain(domain),
			nice: logScale ? false : NICE_TICK_COUNT,
			axis: {
				line: false,
				ticks: {
					size: 0,
					padding: 6,
					values: integerOnly && !logScale ? integerTickValues(domain) : undefined,
					format: options.format ?? ((value: number) => formatValueByUnit(value, options.unit)),
				},
			},
		},
	}
}
