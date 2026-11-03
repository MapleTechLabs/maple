import {
	resetAggregationForMetricType,
	type MetricsQueryDraft,
	type QueryBuilderMetricType,
} from "@maple/query-engine/query-builder"
import { type MetricsQueryDraftSchema, toQueryBuilderMetricType } from "@maple/query-model"
import type { MetricRow } from "../shared"
import { Array as Arr, String as Str } from "effect"

// Pure parts of the metric detail and its breakdown.

export interface QueryState {
	readonly type?: QueryBuilderMetricType | undefined
	readonly agg?: string | undefined
	readonly where?: string | undefined
	readonly groupBy?: string | undefined
	readonly step?: string | undefined
	readonly bd?: string | undefined
}

/** `MetricCatalogSummary`: the union of the catalog rows for one metric name. */
export interface CatalogSummary {
	readonly metricName: string
	readonly metricType: QueryBuilderMetricType
	readonly services: ReadonlyArray<string>
	readonly description: string
	readonly unit: string
	readonly dataPointCount: number
	readonly firstSeen: string
	readonly lastSeen: string
	readonly isMonotonic: boolean
}

/** `summarizeCatalogRows`. */
export const summarizeCatalogRows = (
	rows: ReadonlyArray<MetricRow>,
	metricName: string,
	metricType: QueryBuilderMetricType | undefined,
): CatalogSummary | null => {
	const matches = Arr.filter(
		rows,
		(row) =>
			row.metricName === metricName &&
			toQueryBuilderMetricType(row.metricType) !== null &&
			(metricType === undefined || row.metricType === metricType),
	)
	const first = matches[0]
	const firstType = first === undefined ? null : toQueryBuilderMetricType(first.metricType)
	if (first === undefined || firstType === null) return null
	return {
		metricName,
		metricType: firstType,
		services: [
			...new Set(
				Arr.filter(
					Arr.map(matches, (row) => row.serviceName),
					(name) => name !== "",
				),
			),
		],
		description: Arr.map(matches, (row) => row.metricDescription).find((d) => d.length > 0) ?? "",
		unit: Arr.map(matches, (row) => row.metricUnit).find((u) => u.length > 0) ?? "",
		dataPointCount: Arr.reduce(matches, 0, (total, row) => total + row.dataPointCount),
		firstSeen: Arr.reduce(matches, first.firstSeen, (min, row) =>
			row.firstSeen < min ? row.firstSeen : min,
		),
		lastSeen: Arr.reduce(matches, first.lastSeen, (max, row) =>
			row.lastSeen > max ? row.lastSeen : max,
		),
		isMonotonic: Arr.some(matches, (row) => row.isMonotonic),
	}
}

export const defaultAggregation = (metricType: QueryBuilderMetricType, isMonotonic: boolean): string =>
	resetAggregationForMetricType(metricType === "sum" ? "rate" : "avg", metricType, isMonotonic)

/** `buildMetricExplorerDraft`: the stable-id draft the chart, breakdown and actions share. */
export const buildMetricExplorerDraft = (summary: CatalogSummary, state: QueryState): MetricsQueryDraft => ({
	id: "metrics-explorer-a",
	name: "A",
	enabled: true,
	hidden: false,
	dataSource: "metrics",
	signalSource: "default",
	metricName: summary.metricName,
	metricType: summary.metricType,
	isMonotonic: summary.isMonotonic,
	whereClause: state.where ?? "",
	aggregation: resetAggregationForMetricType(
		state.agg ?? defaultAggregation(summary.metricType, summary.isMonotonic),
		summary.metricType,
		summary.isMonotonic,
	),
	stepInterval: state.step ?? "",
	orderByDirection: "desc",
	addOns: {
		groupBy: state.groupBy !== undefined && state.groupBy !== "",
		having: false,
		orderBy: false,
		limit: false,
		legend: false,
	},
	groupBy: state.groupBy === undefined || state.groupBy === "" ? [] : [state.groupBy],
	having: "",
	orderBy: "",
	limit: "",
	legend: "",
})

export const GROUP_BY_SERIES_LIMIT = 20

/** The chart's query: a group-by caps the series in SQL. */
export const chartQuery = (draft: MetricsQueryDraft): typeof MetricsQueryDraftSchema.Type =>
	draft.groupBy.length > 0 ? { ...draft, seriesLimit: String(GROUP_BY_SERIES_LIMIT) } : draft

export const queryLabel = (draft: MetricsQueryDraft): string =>
	`${draft.aggregation}(${draft.metricName})${draft.groupBy[0] === undefined ? "" : ` by ${draft.groupBy[0]}`}`

export const SERVICE_KEY = "service.name"
export const BREAKDOWN_LIMIT = 10

/** `breakdownAggregation`: breakdown supports plain aggregations; counters fall back to count. */
export const breakdownAggregation = (aggregation: string): "avg" | "sum" | "count" =>
	aggregation === "avg" || aggregation === "sum" || aggregation === "count" ? aggregation : "count"

/** The breakdown's group-by column for the chosen key. */
export const breakdownGroupBy = (key: string): string => (key === SERVICE_KEY ? SERVICE_KEY : `attr.${key}`)

export const buildBreakdownDraft = (draft: MetricsQueryDraft, groupBy: string): MetricsQueryDraft => ({
	...draft,
	id: "metrics-explorer-breakdown",
	aggregation: breakdownAggregation(draft.aggregation),
	groupBy: [groupBy],
	addOns: { ...draft.addOns, groupBy: true, limit: true },
	limit: String(BREAKDOWN_LIMIT),
})

const quoteFilterValue = (value: string): string => `"${Str.replaceAll('"', '\\"')(value)}"`

/** `appendWhereFilter`: adds `key = "value"`, replacing an existing clause for the same key. */
export const appendWhereFilter = (where: string, key: string, value: string): string => {
	const clause = `${key} = ${quoteFilterValue(value)}`
	const trimmed = Str.trim(where)
	if (!trimmed) return clause
	const escapedKey = Str.replaceAll(".", "\\.")(key)
	const sameKeyClause = new RegExp(`${escapedKey}\\s*=\\s*"(?:[^"\\\\]|\\\\.)*"`)
	if (sameKeyClause.test(trimmed)) return Str.replace(sameKeyClause, clause)(trimmed)
	return `${trimmed} AND ${clause}`
}
