import type { MetricDistributionRow, MetricExemplarRow } from "@maple/domain/http"
import { formatValueByUnit } from "@maple/ui/lib/format"
import type { ExemplarDot } from "@maple/views/charts/exemplar-overlay"
import { Array as Arr, DateTime, Option, Order, Record as Rec, String as Str } from "effect"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
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

type Edges = Pick<MetricDistributionRow, "lowerBound" | "upperBound">

/** A heatmap row's identity: its exact edges, open ones as -inf and inf. Labels are only text. */
export const bucketKey = (row: Edges): string => `${row.lowerBound ?? "-inf"}|${row.upperBound ?? "inf"}`

const edgeOf = (text: string | undefined, open: string): number | null | undefined =>
	text === undefined ? undefined : text === open ? null : Number(text)

/** The edges a row key names, or null when it names none. */
export const edgesOfKey = (key: string): Edges | null => {
	const [lower, upper] = Str.split("|")(key)
	const lowerBound = edgeOf(lower, "-inf")
	const upperBound = edgeOf(upper, "inf")
	return lowerBound === undefined || upperBound === undefined ? null : { lowerBound, upperBound }
}

/** A row's label: its upper edge, or both edges when another layout shares that upper edge. */
export const bucketLabel = (row: Edges, format: Format, sharesUpper = false): string => {
	if (row.lowerBound === 0 && row.upperBound === 0) return "0"
	if (row.upperBound === null) return row.lowerBound === null ? "all" : `> ${format(row.lowerBound)}`
	return sharesUpper && row.lowerBound !== null
		? `${format(row.lowerBound)} – ${format(row.upperBound)}`
		: `≤ ${format(row.upperBound)}`
}

const byEdges = Order.combine(
	Order.mapInput(Order.Number, (row: Edges) => row.upperBound ?? Number.POSITIVE_INFINITY),
	Order.mapInput(Order.Number, (row: Edges) => row.lowerBound ?? Number.NEGATIVE_INFINITY),
)

export type DistributionCell = Readonly<{ x: string; y: string; value: number }>

/** At most this many time columns; a longer grid is left to the cells that have data. */
const MAX_COLUMNS = 2000

/** Every time bucket of the window, as the warehouse aligns and writes them. */
export const timeGrid = (
	window: { readonly startTime: string; readonly endTime: string },
	bucketSeconds: number,
): ReadonlyArray<string> | undefined => {
	const width = bucketSeconds * 1000
	const first = Math.floor(parseWarehouseDateTime(window.startTime) / width) * width
	const count = Math.floor((parseWarehouseDateTime(window.endTime) - first) / width) + 1
	return width <= 0 || !Number.isFinite(count) || count <= 0 || count > MAX_COLUMNS
		? undefined
		: Arr.makeBy(count, (i) => DateTime.formatIso(DateTime.makeUnsafe(first + i * width)))
}

/**
 * The heatmap's input: points with time on x and exact bucket keys on y, lowest bucket first
 * (the heatmap draws the first row at the bottom), and the label each key shows.
 */
export const distributionCells = (
	rows: ReadonlyArray<MetricDistributionRow>,
	format: Format,
): { readonly cells: ReadonlyArray<DistributionCell>; readonly labels: Readonly<Record<string, string>> } => {
	const sorted = Arr.sort(rows, byEdges)
	const edges = Arr.dedupeWith(sorted, (a, b) => bucketKey(a) === bucketKey(b))
	const uppers = Arr.map(edges, (row) => row.upperBound)
	const sharesUpper = (row: Edges) => Arr.filter(uppers, (upper) => upper === row.upperBound).length > 1
	return {
		cells: Arr.map(sorted, (row) => ({ x: row.bucket, y: bucketKey(row), value: row.count })),
		labels: Rec.fromEntries(
			Arr.map(edges, (row) => [bucketKey(row), bucketLabel(row, format, sharesUpper(row))]),
		),
	}
}

export interface PickedCell {
	/** The cell's time bucket, as the warehouse writes it. */
	readonly bucket: string
	readonly lowerBound: number | null
	readonly upperBound: number | null
}

/** The picked cell's bucket and exact edges, or null when no current cell has that key. */
export const pickedCell = (
	rows: ReadonlyArray<MetricDistributionRow>,
	cellKey: string,
): PickedCell | null => {
	const parts = cellKeyParts(cellKey)
	const edges = parts === null ? null : edgesOfKey(parts.y)
	if (parts === null || edges === null) return null
	const present = Arr.some(rows, (row) => sameInstant(row.bucket, parts.x) && bucketKey(row) === parts.y)
	return present ? { bucket: formatWarehouseDateTime(isoMs(parts.x)), ...edges } : null
}

const sameInstant = (a: string, b: string): boolean => isoMs(a) === isoMs(b)

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

/** A chart bucket's time in epoch ms, from the API's ISO or the warehouse's `YYYY-MM-DD HH:MM:SS`. */
export const bucketMs = (bucket: string): number => parseWarehouseDateTime(bucket)

/** The line's top value per bucket time, which a dot is measured against. */
export const lineValuesByMs = (
	rows: ReadonlyArray<Readonly<Record<string, string | number | boolean>>>,
): ReadonlyMap<number, number> =>
	new Map(
		Arr.flatMap(rows, (row) => {
			const values = Arr.filter(Rec.values(row), (value): value is number => typeof value === "number")
			return typeof row["bucket"] === "string" && values.length > 0
				? [[bucketMs(row["bucket"]), Math.max(...values)] as const]
				: []
		}),
	)

/** The chart's dots: one per exemplar, at its time and value, with the line's value under it. */
export const exemplarDots = (
	exemplars: ReadonlyArray<MetricExemplarRow>,
	format: Format,
	timeZone: string,
	lineValues: ReadonlyMap<number, number> = new Map(),
): ReadonlyArray<ExemplarDot> =>
	Arr.map(exemplars, (exemplar) => ({
		key: exemplarKey(exemplar),
		// At its bucket, the line point whose value it explains (the line is drawn at bucket starts).
		atMs: isoMs(exemplar.bucket),
		baseline: lineValues.get(isoMs(exemplar.bucket)),
		value: exemplar.value,
		title: format(exemplar.value),
		rows: [
			{ label: "Service", value: exemplar.serviceName },
			{ label: "Time", value: exemplarTime(exemplar.timestamp, timeZone) },
			{ label: "Trace", value: Str.slice(0, 16)(exemplar.traceId) },
		],
	}))
