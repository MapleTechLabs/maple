import {
	axisTickFormatter,
	axisTickValues,
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
import { Array as Arr, Record as Rec } from "effect"

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
			Arr.flatMap(data, (row) =>
				Arr.filter(Rec.keys(row), (key) => key !== "bucket" && key !== "partial"),
			),
		),
	]
	return {
		definitions: Arr.map(rawKeys.slice(0, HARD_SERIES_LIMIT), (rawKey, index): SeriesDefinition => ({
			rawKey,
			chartKey: `s${index + 1}`,
		})),
		totalSeriesCount: rawKeys.length,
	}
}

/** The rows of `normaliseTimeseriesRows`, values keyed by chart key; unparseable buckets dropped. */
export const normaliseRows = (
	data: ReadonlyArray<Readonly<Record<string, unknown>>>,
	definitions: ReadonlyArray<SeriesDefinition>,
): Array<TimeseriesRow> =>
	Arr.flatMap(data, (row): Array<TimeseriesRow> => {
		const bucket = typeof row.bucket === "string" ? row.bucket : ""
		const epochMs = parseBucketMs(bucket)
		if (epochMs == null) return []
		const next: TimeseriesRow = { bucket, date: new Date(epochMs) }
		if (row.partial === true) next.partial = true
		Arr.forEach(definitions, (definition) => {
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
	if (unit !== "requests_per_sec" || bucketSeconds === undefined || bucketSeconds <= 0) return rows
	return Arr.map(rows, (row) => {
		const next: TimeseriesRow = { bucket: row.bucket, date: row.date }
		if (row.partial) next.partial = true
		Arr.forEach(keys, (key) => {
			next[key] = asFiniteNumber(row[key]) / bucketSeconds
		})
		return next
	})
}

/** `resolveSeriesColors` by chart key: tokens (`var(--chart-1)`) or literals. */
export const seriesColorTokens = (
	definitions: ReadonlyArray<SeriesDefinition>,
): ReadonlyMap<string, string> => {
	const byRawKey = resolveSeriesColors(Arr.map(definitions, (definition) => definition.rawKey))
	return new Map(
		Arr.map(definitions, (definition) => [
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
	return Arr.map(definitions, (definition) => ({
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
	/** Tick labels; defaults to `axisTickFormatter(unit, domain)`. */
	readonly format?: (value: number) => string
	readonly logScale?: boolean
	readonly fitYAxisToData?: boolean
	readonly thresholds?: ReadonlyArray<{ readonly value: number }>
	/** A hard ceiling: the domain tops out here, not where nicing rounds it, and its tick is drawn. */
	readonly max?: number
	/** The zero tick's label in place of "0". */
	readonly zeroLabel?: string
}

/** The zero tick reads "0" (or the axis's `zeroLabel`), never "0/s" or "0.00". */
const zeroTick =
	(format: (value: number) => string, zeroLabel = "0") =>
	(value: number): string =>
		value === 0 ? zeroLabel : format(value)

/** A capped axis's ticks: the usual steps under the ceiling, minus any crowding it, then the ceiling. */
const cappedTickValues = (domain: readonly [number, number]): Array<number> => {
	const ticks = axisTickValues(domain, NICE_TICK_COUNT)
	const step = ticks.length > 1 ? (ticks[1] ?? 0) - (ticks[0] ?? 0) : domain[1] - domain[0]
	return [...Arr.filter(ticks, (tick) => domain[1] - tick >= step / 2), domain[1]]
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
	const max = logScale ? undefined : options.max
	const niced: [number, number] = logScale ? logYDomain(dataDomain[1]) : niceLinearDomain(dataDomain)
	const domain: [number, number] = max === undefined ? niced : [Math.min(niced[0], max - 1), max]
	const integerOnly =
		hasOnlyIntegerValues(options.rows, options.visibleKeys) &&
		options.unit == null &&
		options.format == null
	return {
		domain,
		y: {
			grid: DASHED_Y_GRID,
			scale: logScale ? logYScale(dataDomain[1]) : scaleLinear().domain(domain),
			nice: logScale || max !== undefined ? false : NICE_TICK_COUNT,
			axis: {
				line: false,
				ticks: {
					size: 0,
					padding: 6,
					values:
						max !== undefined
							? cappedTickValues(domain)
							: integerOnly && !logScale
								? integerTickValues(domain)
								: undefined,
					format: zeroTick(
						options.format ?? axisTickFormatter(options.unit, domain, NICE_TICK_COUNT),
						options.zeroLabel,
					),
				},
			},
		},
	}
}
