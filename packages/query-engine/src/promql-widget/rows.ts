// A PromQL result as the widget renderers read rows. Pure.
//
// Line, area and bar get the wide `{ bucket, [series]: value }` rows the query
// builder's timeseries produces; a stat or gauge gets `{ bucket, value }` for its
// reducer; every other panel gets one row per series: `name`, the labels, `value`.
import type { Labels, QueryResult } from "@maple/promql"
import { Array as Arr, Order, Record as Rec, String as Str } from "effect"
import { replaceWith } from "@maple/strings"

export type PromqlRow = Record<string, string | number>

/** The engine's result, for hosts that do not depend on `@maple/promql` directly. */
export type PromqlQueryResult = QueryResult

/** Steps a widget aims for: Grafana-like resolution without a 10k-point payload. */
export const PROMQL_TARGET_POINTS = 200
const MIN_POINTS = 100
const MAX_POINTS = 300

/** Default floor: one scrape interval, as Grafana's Prometheus source does. */
export const PROMQL_DEFAULT_MIN_STEP_SECONDS = 15

const NICE_STEPS_SECONDS = [
	1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
] as const

/**
 * The range-query step for a window: the smallest round step that keeps the series near
 * `maxDataPoints` (clamped to 100..300, default 200), never under `minStepSeconds`.
 */
export function promqlStepSeconds(input: {
	readonly startMs: number
	readonly endMs: number
	readonly maxDataPoints?: number
	readonly minStepSeconds?: number
}): number {
	const target = Math.min(MAX_POINTS, Math.max(MIN_POINTS, input.maxDataPoints ?? PROMQL_TARGET_POINTS))
	const rangeSeconds = Math.max(0, input.endMs - input.startMs) / 1000
	const raw = rangeSeconds / target
	const nice = Arr.findFirst(NICE_STEPS_SECONDS, (step) => step >= raw)
	const step = nice._tag === "Some" ? nice.value : Math.ceil(raw / 86400) * 86400
	const floor = input.minStepSeconds ?? PROMQL_DEFAULT_MIN_STEP_SECONDS
	return Math.max(step, floor > 0 ? floor : 1)
}

/** A label set as Prometheus prints it: `name{a="b", c="d"}`, `__name__` as the prefix. */
export function formatPromqlLabels(labels: Labels): string {
	const name = labels.__name__ ?? ""
	const pairs = Arr.map(
		Arr.sort(
			Arr.filter(Rec.keys(labels), (key) => key !== "__name__"),
			Order.String,
		),
		(key) => `${key}="${labels[key] ?? ""}"`,
	)
	if (pairs.length === 0) return name === "" ? "{}" : name
	return `${name}{${Arr.join(pairs, ", ")}}`
}

/**
 * A series' display name: `legendFormat` with `{{label}}` filled from the labels (an absent
 * label is empty, as in Grafana), or the printed label set when there is no format.
 */
export function formatPromqlLegend(labels: Labels, legendFormat?: string): string {
	if (legendFormat === undefined || Str.trim(legendFormat) === "") return formatPromqlLabels(labels)
	return replaceWith(
		legendFormat,
		/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
		(_match, key: string | undefined) => (key === undefined ? "" : (labels[key] ?? "")),
	)
}

interface NamedSeries {
	readonly name: string
	readonly labels: Labels
	readonly points: ReadonlyArray<{ readonly t: number; readonly v: number }>
}

/** Every result type as series, sorted by label set; repeated names get ` (2)`, ` (3)`. */
const namedSeries = (result: QueryResult, legendFormat?: string): ReadonlyArray<NamedSeries> => {
	const raw: ReadonlyArray<{ labels: Labels; points: NamedSeries["points"] }> =
		result.resultType === "matrix"
			? Arr.map(result.result, (series) => ({ labels: series.labels, points: series.points }))
			: result.resultType === "vector"
				? Arr.map(result.result, (sample) => ({
						labels: sample.labels,
						points: [{ t: sample.t, v: sample.value }],
					}))
				: result.resultType === "scalar"
					? [{ labels: {}, points: [result.result] }]
					: []
	const sorted = Arr.sort(
		raw,
		Order.mapInput(Order.String, (series: { labels: Labels }) => formatPromqlLabels(series.labels)),
	)
	// `bucket` is the row's time column; every name, literal or suffixed, is unique.
	const taken = new Set<string>(["bucket"])
	return Arr.map(sorted, (series) => {
		const base =
			result.resultType === "scalar" ? "scalar" : formatPromqlLegend(series.labels, legendFormat)
		let name = base
		for (let n = 2; taken.has(name); n++) name = `${base} (${n})`
		taken.add(name)
		return { name, labels: series.labels, points: series.points }
	})
}

const isoOf = (t: number): string => new Date(t).toISOString()

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null)

const timeseriesRows = (series: ReadonlyArray<NamedSeries>): ReadonlyArray<PromqlRow> => {
	const byTime = new Map<number, PromqlRow>()
	Arr.forEach(series, ({ name, points }) =>
		Arr.forEach(points, ({ t, v }) => {
			const value = finite(v)
			const row = byTime.get(t) ?? { bucket: isoOf(t) }
			// An own data property, so a series named `__proto__` is a column, not the prototype.
			if (value !== null)
				Object.defineProperty(row, name, {
					value,
					enumerable: true,
					writable: true,
					configurable: true,
				})
			byTime.set(t, row)
		}),
	)
	return Arr.map(Arr.sort([...byTime.keys()], Order.Number), (t) => byTime.get(t) ?? { bucket: isoOf(t) })
}

const lastValue = (series: NamedSeries): number | null => {
	const last = Arr.last(series.points)
	return last._tag === "Some" ? finite(last.value.v) : null
}

const STAT_DISPLAY_TYPES = new Set(["stat", "gauge"])
const TIMESERIES_DISPLAY_TYPES = new Set(["line", "area", "bar"])

/**
 * A PromQL result as rows for a panel. `displayType` is the raw-SQL display type the panel maps
 * to (absent reads as a line chart). A stat reads the first series only, newest point first.
 */
export function promqlRowsForDisplay(
	result: QueryResult,
	options: { readonly displayType?: string; readonly legendFormat?: string } = {},
): ReadonlyArray<PromqlRow> {
	const displayType = options.displayType ?? "line"
	if (result.resultType === "string") return [{ name: "string", value: result.result.v }]
	const series = namedSeries(result, options.legendFormat)
	if (TIMESERIES_DISPLAY_TYPES.has(displayType)) return timeseriesRows(series)
	if (STAT_DISPLAY_TYPES.has(displayType)) {
		// Newest first, so the default `first` reducer reads the last value, as Grafana's stat does.
		const first = Arr.head(series)
		if (first._tag === "None") return []
		return Arr.reverse(
			Arr.flatMap(first.value.points, ({ t, v }) => {
				const value = finite(v)
				return value === null ? [] : [{ bucket: isoOf(t), value }]
			}),
		)
	}
	return Arr.flatMap(series, (one) => {
		const value = lastValue(one)
		// `name` and `value` are the row's own columns; a label of either name moves to the first
		// `label_` name no other label holds, so no label value is lost.
		const keys = new Set(Rec.keys(one.labels))
		const moved = (key: string): string => {
			let candidate = `label_${key}`
			while (keys.has(candidate)) candidate = `label_${candidate}`
			keys.add(candidate)
			return candidate
		}
		const entries = Arr.map(Rec.toEntries(one.labels), ([key, label]): readonly [string, string] => [
			key === "name" || key === "value" ? moved(key) : key,
			label,
		])
		return value === null ? [] : [{ ...Rec.fromEntries(entries), name: one.name, value }]
	})
}
