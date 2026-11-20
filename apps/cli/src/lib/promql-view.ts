// `maple promql` in table mode: one row per series with its last value, min/avg/max and a
// sparkline of the listed points. JSON mode prints `query_promql`'s output unchanged.

import { Array as Arr, Order, Record as Rec, String as Str } from "effect"
import type { PromqlSampleValue } from "@maple/domain/mcp-outputs"
import type { PromqlOutput } from "../core/promql"
import { formatDecimal, renderFields, renderTable, type View } from "./output"

type Sample = typeof PromqlSampleValue.Type
type Series = PromqlOutput["series"][number]

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const
const SPARK_WIDTH = 24

export const formatSample = (value: Sample | undefined): string =>
	value === undefined ? "-" : typeof value === "number" ? formatDecimal(value) : value

/** `__name__{a="1", b="2"}`, Prometheus' own spelling; `{}` for a series with no labels. */
/** Prometheus' escaping, so distinct label sets never print alike. */
const escapeLabelValue = (value: string): string =>
	Str.replaceAll("\n", "\\n")(Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(value)))

export const formatLabels = (labels: Readonly<Record<string, string>>): string => {
	const name = labels.__name__ ?? ""
	const pairs = Arr.map(
		Arr.sort(
			Arr.filter(Rec.keys(labels), (k) => k !== "__name__"),
			Order.String,
		),
		(k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`,
	)
	return pairs.length === 0 && name !== "" ? name : `${name}{${Arr.join(pairs, ", ")}}`
}

/**
 * The values as block characters, low to high, over at most {@link SPARK_WIDTH} columns
 * (each the mean of its points). A non-finite or missing value is a space.
 */
export const sparkline = (values: ReadonlyArray<Sample>, width = SPARK_WIDTH): string => {
	const finite = (v: Sample): v is number => typeof v === "number"
	const columns = Math.min(width, values.length)
	if (columns === 0) return ""
	const buckets = Arr.makeBy(columns, (i) => {
		const slice = Arr.filter(
			values.slice(
				Math.floor((i * values.length) / columns),
				Math.floor(((i + 1) * values.length) / columns),
			),
			finite,
		)
		return slice.length === 0 ? undefined : Arr.reduce(slice, 0, (a, b) => a + b) / slice.length
	})
	const present = Arr.filter(buckets, (v): v is number => v !== undefined)
	if (present.length === 0) return Str.repeat(columns)(" ")
	const min = Math.min(...present)
	const span = Math.max(...present) - min
	return Arr.join(
		Arr.map(buckets, (v) =>
			v === undefined
				? " "
				: (SPARK[span === 0 ? 3 : Math.round(((v - min) / span) * (SPARK.length - 1))] ?? " "),
		),
		"",
	)
}

const last = (series: Series): Sample | undefined => series.points[series.points.length - 1]?.v

/** The labels every series carries with the same value, when there is more than one series. */
export const commonLabels = (series: ReadonlyArray<Series>): Readonly<Record<string, string>> => {
	const [first, ...rest] = series
	if (first === undefined || rest.length === 0) return {}
	return Rec.filter(first.labels, (value, key) => Arr.every(rest, (s) => s.labels[key] === value))
}

const without = (labels: Readonly<Record<string, string>>, common: Readonly<Record<string, string>>) =>
	Rec.filter(labels, (_, key) => !Rec.has(common, key))

const columnsFor = (d: PromqlOutput, common: Readonly<Record<string, string>>) => {
	const label = {
		header: "SERIES",
		cell: (s: Series) => (d.resultType === "scalar" ? "scalar" : formatLabels(without(s.labels, common))),
		maxWidth: d.resultType === "matrix" ? 72 : 96,
	}
	if (d.resultType !== "matrix") {
		return [
			label,
			{ header: "VALUE", cell: (s: Series) => formatSample(last(s)), align: "right" as const },
		]
	}
	return [
		label,
		{ header: "LAST", cell: (s: Series) => formatSample(last(s)), align: "right" as const },
		{ header: "MIN", cell: (s: Series) => formatSample(s.stats?.min), align: "right" as const },
		{ header: "AVG", cell: (s: Series) => formatSample(s.stats?.avg), align: "right" as const },
		{ header: "MAX", cell: (s: Series) => formatSample(s.stats?.max), align: "right" as const },
		{ header: "POINTS", cell: (s: Series) => String(s.totalPoints), align: "right" as const },
		{ header: "TREND", cell: (s: Series) => sparkline(Arr.map(s.points, (p) => p.v)) },
	]
}

const windowField = (d: PromqlOutput): readonly [string, string] =>
	d.instant
		? ["at", `${d.timeRange.end} UTC`]
		: ["window", `${d.timeRange.start} .. ${d.timeRange.end} UTC`]

export const promqlNotes = (d: PromqlOutput): ReadonlyArray<string> => [
	...(d.totalSeries > d.series.length
		? [
				`showing ${d.series.length} of ${d.totalSeries} series (highest peaks); aggregate with sum by (...) to see all`,
			]
		: []),
	...(Arr.some(d.series, (s) => s.totalPoints > s.points.length)
		? [
				`trend shows the last ${Math.max(...Arr.map(d.series, (s) => s.points.length))} points of each series`,
			]
		: []),
]

export const promqlView = (empty: string): View<PromqlOutput> => ({
	empty,
	// Labels are data: the timestamp replacer would respell a label named like a time field.
	raw: true,
	isEmpty: (d) => d.series.length === 0 && d.stringValue === undefined,
	notes: promqlNotes,
	table: (d) => {
		const common = commonLabels(d.series)
		const fields = renderFields([
			["query", d.query],
			["result", d.resultType],
			windowField(d),
			...(d.instant ? [] : [["step", `${d.stepSeconds}s`] as const]),
			...(Rec.isEmptyRecord(common)
				? []
				: [["labels", `${formatLabels(common)} (on every series)`] as const]),
		])
		if (d.resultType === "string")
			return [{ body: fields }, { title: "VALUE", body: d.stringValue ?? "" }]
		return [{ body: fields }, { body: renderTable(columnsFor(d, common), d.series) }]
	},
})
