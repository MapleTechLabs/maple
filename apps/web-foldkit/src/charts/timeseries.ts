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

// The React-free half of `Timeseries` (packages/ui/src/components/plot/timeseries.tsx): row
// normalisation, series keys and colour tokens, and the shared x and y axes. Copied, as that
// module also holds the React model hook and frame.

export const HARD_SERIES_LIMIT = 60
export const SERIES_FALLBACK_COLOR = DEFAULT_TOKEN_FALLBACK

/** One normalised row: the bucket, its parsed date, and every series value by chart key. */
export interface TimeseriesRow extends Record<string, unknown> {
	bucket: string
	date: Date
	partial?: boolean
}

export const asFiniteNumber = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

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

export interface AxisContext {
	readonly rangeMs: number
	readonly bucketSeconds: number | undefined
	readonly domainMs?: readonly [number, number]
	readonly timeZone?: string
}

export const rowsDomainMs = (
	rows: ReadonlyArray<{ readonly date: Date }>,
): readonly [number, number] | undefined => {
	const first = rows[0]?.date.getTime()
	const last = rows[rows.length - 1]?.date.getTime()
	if (first === undefined || last === undefined || !Number.isFinite(first) || !Number.isFinite(last))
		return undefined
	return [Math.min(first, last), Math.max(first, last)]
}

export const axisContextOf = (
	rows: ReadonlyArray<TimeseriesRow>,
	timeZone: string | undefined,
): AxisContext => ({
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
const edgeTickAnchor = (axisContext: AxisContext) => {
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
export const timeseriesXAxis = (axisContext: AxisContext) => ({
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
}

/** `timeseriesYAxis` without log, soft bounds or thresholds (the metric chart passes none). */
export const timeseriesYAxis = (options: YAxisOptions) => {
	const dataDomain = linearYDomain({
		rows: options.rows,
		keys: options.visibleKeys,
		stacked: options.stacked,
		fitYAxisToData: false,
	})
	const domain: [number, number] = niceLinearDomain(dataDomain)
	const integerOnly = hasOnlyIntegerValues(options.rows, options.visibleKeys) && options.unit == null
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
					format: (value: number) => formatValueByUnit(value, options.unit),
				},
			},
		},
	}
}
