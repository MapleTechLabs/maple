import { QUERY_BUILDER_METRIC_TYPES, toQueryBuilderMetricType } from "@maple/query-model"
import { getMetricAttributeKeys, listMetrics } from "@maple/web-data/warehouse/metrics"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { applyQueryChange, QueryChange } from "../../kit/query-builder/change"
import type { MetricOption } from "./metric-option"
import type { EditorState } from "./editor-state"
import { Message } from "./message"
import type { Model } from "./model"

// `useWidgetBuilderData`'s metric list: one page of the org's metrics for what the picker searched,
// each name and type once, fetched while a query reads metrics.

export type { MetricOption } from "./metric-option"

/** `listMetricsResultAtom({ data: { limit: 100, search } })`, reduced to picker options. */
export const FetchMetricOptions = Command.define("FetchWidgetEditorMetricOptions", {
	args: { search: Schema.String },
	messages: [Message.CompletedFetchMetricOptions],
	execute: ({ search }) =>
		listMetrics({ data: { limit: 100, ...(search === "" ? undefined : { search }) } }).pipe(
			Effect.map((response) => ({
				options: response.data
					.filter((row) => toQueryBuilderMetricType(row.metricType) !== undefined)
					.map((row) => ({
						value: `${row.metricName}::${row.metricType}`,
						label: `${row.metricName} (${row.metricType})`,
						isMonotonic: row.isMonotonic,
					}))
					.filter(
						(option, index, all) =>
							all.findIndex((other) => other.value === option.value) === index,
					),
				// `toNames`: trimmed, non-empty, each once.
				services: response.data
					.map((row) => row.serviceName.trim())
					.filter((name, index, all) => name !== "" && all.indexOf(name) === index),
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMetricOptions({ search, result })),
		),
})

/** `getMetricAttributeKeysResultAtom`: the picked metric's attribute keys over the last 24 h. */
export const FetchMetricKeys = Command.define("FetchWidgetEditorMetricKeys", {
	args: { metricName: Schema.String, metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES) },
	messages: [Message.CompletedFetchMetricKeys],
	execute: ({ metricName, metricType }) =>
		getMetricAttributeKeys({ data: { metricName, metricType } }).pipe(
			Effect.map((response) => response.data.map((row) => row.attributeKey)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) =>
				Message.CompletedFetchMetricKeys({ metric: `${metricName}::${metricType}`, result }),
			),
		),
})

const metricsQueriesOf = (state: EditorState | null) =>
	(state?.queries ?? []).flatMap((query) => (query.dataSource === "metrics" ? [query] : []))

type Asked = Readonly<{
	model: Model
	commands: ReadonlyArray<ReturnType<typeof FetchMetricOptions | typeof FetchMetricKeys>>
}>

/** The list is asked for once per search, and each picked metric's keys once, while a query reads metrics. */
export const askMetricOptions = (model: Model): Asked => {
	const queries = metricsQueriesOf(model.state)
	if (queries.length === 0) return { model, commands: [] }
	const list =
		model.metricRequested === model.metricSearch
			? []
			: [FetchMetricOptions({ search: model.metricSearch })]
	const missing = queries
		.filter((query) => query.metricName !== "")
		.map((query) => ({ metricName: query.metricName, metricType: query.metricType }))
		.filter(
			(metric, index, all) =>
				!model.metricKeysRequested.includes(`${metric.metricName}::${metric.metricType}`) &&
				all.findIndex(
					(other) =>
						other.metricName === metric.metricName && other.metricType === metric.metricType,
				) === index,
		)
	return {
		model: {
			...model,
			metricRequested: model.metricSearch,
			metricKeysRequested: [
				...model.metricKeysRequested,
				...missing.map((metric) => `${metric.metricName}::${metric.metricType}`),
			],
		},
		commands: [...list, ...missing.map((metric) => FetchMetricKeys(metric))],
	}
}

/** `parseMetricSelection`: `name::type` back into the metric it names. */
export const pickedMetric = (value: string, options: ReadonlyArray<MetricOption>): QueryChange | null => {
	const [metricName = "", rawType = ""] = value.split("::")
	const metricType = QUERY_BUILDER_METRIC_TYPES.find((type) => type === rawType)
	if (metricName === "" || metricType === undefined) return null
	const isMonotonic = options.find((option) => option.value === value)?.isMonotonic ?? metricType === "sum"
	return QueryChange.SetMetric({ metricName, metricType, isMonotonic })
}

export const optionsOf = (model: Model): ReadonlyArray<MetricOption> => model.metricOptions?.options ?? []

/** The first page's first metric fills any metrics query that has none yet (once). */
export const withDefaultMetric = (state: EditorState, options: ReadonlyArray<MetricOption>): EditorState => {
	const first = options[0]
	if (first === undefined) return state
	const change = pickedMetric(first.value, options)
	if (change === null || change._tag !== "SetMetric") return state
	return {
		...state,
		queries: state.queries.map((query) =>
			query.dataSource === "metrics" && query.metricName === ""
				? applyQueryChange(query, change)
				: query,
		),
	}
}
