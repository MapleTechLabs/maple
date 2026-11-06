import { formulaLabel, queryLabel } from "@maple/query-engine/query-builder"
import type { TimeseriesQuerySetDiagnostics } from "@maple/query-engine/query-set"
import { QUERY_BUILDER_METRIC_TYPES, type QueryBuilderMetricType } from "@maple/query-model"
import type { QueryDraft } from "../../page/kit/query-builder/draft"
import type { ScrollAreaOverflowY } from "@maple/views/ui/scroll-area"
import type { FormulaDraft, MetricRow, RunPoint, ScrollMetrics } from "./model"
import { Array as Arr, Record as Rec, String as Str } from "effect"

// The lab's pure helpers.

const isMetricType = (value: string): value is QueryBuilderMetricType =>
	Arr.some(QUERY_BUILDER_METRIC_TYPES, (type) => type === value)

/** `toRunPoints`: each row's bucket and its finite numeric series. */
export const toRunPoints = (
	rows: ReadonlyArray<Readonly<Record<string, string | number>>>,
): ReadonlyArray<RunPoint> =>
	Arr.map(rows, (row) => ({
		bucket: String(row["bucket"] ?? ""),
		series: Rec.fromEntries(
			Arr.flatMap(Rec.toEntries(row), ([key, value]) => {
				if (key === "bucket") return []
				const numeric = typeof value === "number" ? value : Number(value)
				return Number.isFinite(numeric) ? [[key, numeric] as const] : []
			}),
		),
	}))

/** `debugWarnings`: the queries that fell back to a wider range. */
export const debugWarnings = (diagnostics: TimeseriesQuerySetDiagnostics): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(diagnostics.queries, (entry) => entry.fallbackUsed),
		(entry) => `${entry.queryName} used fallback range`,
	)

/** The first six series keys across the points, in first-seen order. */
export const seriesKeysOf = (points: ReadonlyArray<RunPoint>): ReadonlyArray<string> =>
	Array.from(new Set(Arr.flatMap(points, (point) => Rec.keys(point.series)))).slice(0, 6)

export type MetricOption = Readonly<{
	value: string
	label: string
	metricName: string
	metricType: QueryBuilderMetricType
}>

/** `metricOptions`: one option per known name and type, first occurrence wins. */
export const metricOptionsOf = (rows: ReadonlyArray<MetricRow>): ReadonlyArray<MetricOption> => {
	const options = Arr.flatMap(rows, (row): ReadonlyArray<MetricOption> => {
		const { metricType } = row
		if (!isMetricType(metricType)) return []
		const value = `${row.metricName}::${metricType}`
		return [{ value, label: `${row.metricName} (${metricType})`, metricName: row.metricName, metricType }]
	})
	return Arr.dedupeWith(options, (a, b) => a.value === b.value)
}

/** `parseMetricSelection`: `name::type` back into its parts. */
export const parseMetricSelection = (
	raw: string,
): Readonly<{ metricName: string; metricType: QueryBuilderMetricType }> | null => {
	const [metricName, metricType = ""] = Str.split("::")(raw)
	if (metricName === "" || !isMetricType(metricType)) return null
	return { metricName, metricType }
}

/** The effect on `metricOptions`: a metrics query with no metric takes the first one. */
export const withFirstMetric = (
	queries: ReadonlyArray<QueryDraft>,
	options: ReadonlyArray<MetricOption>,
): ReadonlyArray<QueryDraft> => {
	const [first] = options
	if (first === undefined) return queries
	return Arr.map(queries, (query) =>
		query.dataSource !== "metrics" || query.metricName !== ""
			? query
			: { ...query, metricName: first.metricName, metricType: first.metricType },
	)
}

export const relabelQueries = (queries: ReadonlyArray<QueryDraft>): ReadonlyArray<QueryDraft> =>
	Arr.map(queries, (query, index) => ({ ...query, name: queryLabel(index) }))

export const relabelFormulas = (formulas: ReadonlyArray<FormulaDraft>): ReadonlyArray<FormulaDraft> =>
	Arr.map(formulas, (formula, index) => ({ ...formula, name: formulaLabel(index) }))

// copied: the lab's own `GROUP_BY_OPTIONS` (not query-engine's, which lists other fields).
const GROUP_BY_OPTIONS = {
	traces: ["service.name", "span.name", "status.code", "http.method", "none"],
	logs: ["service.name", "severity", "none"],
	metrics: ["service.name", "none"],
	product_events: ["event.name", "page.path", "none"],
} satisfies Record<QueryDraft["dataSource"], ReadonlyArray<string>>

/** `GroupByAutocomplete`'s options: the static fields, then span attributes as `attr.*` for traces. */
export const groupByOptionsOf = (
	dataSource: QueryDraft["dataSource"],
	attributeKeys: ReadonlyArray<string>,
): ReadonlyArray<string> => [
	...GROUP_BY_OPTIONS[dataSource],
	...(dataSource === "traces"
		? Arr.map(
				Arr.filter(
					attributeKeys,
					(key) =>
						!Str.startsWith("http.request.header.")(key) &&
						!Str.startsWith("http.response.header.")(key),
				),
				(key) => `attr.${key}`,
			)
		: []),
]

/** Base UI's thumb: the track (viewport less the scrollbar's `m-1`) scaled by the visible share. */
const SCROLLBAR_MARGIN_PX = 8
const MIN_THUMB_PX = 16

export const scrollOverflowOf = (metrics: ScrollMetrics | null): ScrollAreaOverflowY | undefined => {
	if (metrics === null || metrics.scrollHeight <= metrics.clientHeight) return undefined
	const { clientHeight, scrollHeight } = metrics
	const track = clientHeight - SCROLLBAR_MARGIN_PX
	return {
		endPx: scrollHeight - clientHeight,
		thumbHeightPx: Math.max(MIN_THUMB_PX, (track * clientHeight) / scrollHeight),
	}
}
