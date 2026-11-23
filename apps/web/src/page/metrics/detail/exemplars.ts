import type { MetricDistributionRow, MetricExemplarRow } from "@maple/domain/http"
import { formatValueByUnit } from "@maple/ui/lib/format"
import type { ExemplarDot } from "@maple/views/charts/exemplar-overlay"
import { Array as Arr, DateTime, Option, Order, String as Str } from "effect"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { keepsMetricUnit } from "./derive"

// The histogram distribution as heatmap points, the exemplars as chart dots and rows, and the
// heatmap cell an exemplar falls in.

export const isHistogramType = (metricType: string): boolean =>
	metricType === "histogram" || metricType === "exponential_histogram"

/**
 * Whether exemplar dots sit on the chart's y scale: the line must read in the metric's unit
 * as one observation does. A sum or an increase adds observations up, so it does not.
 */
export const exemplarsFitChart = (aggregation: string, metricType: string): boolean =>
	(isHistogramType(metricType) || metricType === "gauge") &&
	keepsMetricUnit(aggregation) &&
	aggregation !== "sum" &&
	aggregation !== "increase"

type Format = (value: number) => string

/** One heatmap row's label: the bucket's upper edge, which is unique per merged bucket. */
export const bucketLabel = (row: MetricDistributionRow, format: Format): string => {
	if (row.lowerBound === 0 && row.upperBound === 0) return "0"
	if (row.upperBound === null) return row.lowerBound === null ? "all" : `> ${format(row.lowerBound)}`
	return `≤ ${format(row.upperBound)}`
}

const byUpperBound = Order.mapInput(
	Order.Number,
	(row: MetricDistributionRow) => row.upperBound ?? Number.POSITIVE_INFINITY,
)

export type DistributionCell = Readonly<{ x: string; y: string; value: number }>

/**
 * Heatmap points with time on x and value buckets on y, lowest bucket first (the heatmap draws
 * the first row at the bottom).
 */
export const distributionCells = (
	rows: ReadonlyArray<MetricDistributionRow>,
	format: Format,
): ReadonlyArray<DistributionCell> =>
	Arr.map(Arr.sort(rows, byUpperBound), (row) => ({
		x: row.bucket,
		y: bucketLabel(row, format),
		value: row.count,
	}))

export interface PickedCell {
	/** The cell's time bucket, as the warehouse writes it. */
	readonly bucket: string
	readonly lowerBound: number | null
	readonly upperBound: number | null
}

/** The picked cell's bucket and value range, or null when no current cell has that key. */
export const pickedCell = (
	rows: ReadonlyArray<MetricDistributionRow>,
	cellKey: string,
	format: Format,
): PickedCell | null => {
	const parts = cellKeyParts(cellKey)
	const row =
		parts === null
			? undefined
			: Arr.findFirst(
					rows,
					(candidate) => candidate.bucket === parts.x && bucketLabel(candidate, format) === parts.y,
				)
	return row === undefined || Option.isNone(row)
		? null
		: {
				bucket: formatWarehouseDateTime(isoMs(row.value.bucket)),
				lowerBound: row.value.lowerBound,
				upperBound: row.value.upperBound,
			}
}

/** The heatmap focus key of a cell: `x`, a NUL, then `y` (`heatmap-chart`'s `focusKeyOf`). */
export const cellKeyParts = (key: string): { readonly x: string; readonly y: string } | null => {
	const [x, y] = Str.split("\u0000")(key)
	return x === undefined || y === undefined ? null : { x, y }
}

/** An API timestamp (ISO 8601 with its zone) in epoch ms; NaN when it does not parse. */
export const isoMs = (iso: string): number =>
	Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })

export const exemplarKey = (exemplar: MetricExemplarRow): string =>
	`${exemplar.traceId}:${exemplar.spanId}:${exemplar.timestamp}`

/** The value in the chart's unit, or a plain number. */
export const valueFormat =
	(unit: string | undefined): Format =>
	(value) =>
		formatValueByUnit(value, unit)

/** An exemplar's time to the second, in the viewer's zone. */
export const exemplarTime = (iso: string, timeZone: string): string =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(isoMs(iso))

/**
 * What the chart draws: each time bucket's highest exemplar (rows come highest first), so a
 * quiet hour reads as a light trail and a spike stands out by height. The table lists the rest.
 */
export const chartExemplars = (
	exemplars: ReadonlyArray<MetricExemplarRow>,
): ReadonlyArray<MetricExemplarRow> => Arr.dedupeWith(exemplars, (a, b) => a.bucket === b.bucket)

/** The chart's dots: one per exemplar, at its time and value. */
export const exemplarDots = (
	exemplars: ReadonlyArray<MetricExemplarRow>,
	format: Format,
	timeZone: string,
): ReadonlyArray<ExemplarDot> =>
	Arr.map(exemplars, (exemplar) => ({
		key: exemplarKey(exemplar),
		atMs: isoMs(exemplar.timestamp),
		value: exemplar.value,
		title: format(exemplar.value),
		rows: [
			{ label: "Service", value: exemplar.serviceName },
			{ label: "Time", value: exemplarTime(exemplar.timestamp, timeZone) },
			{ label: "Trace", value: Str.slice(0, 16)(exemplar.traceId) },
		],
	}))
