import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { Effect, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import { applyQueryChange } from "../../kit/query-builder/change"
import {
	listMetricOptions,
	type MetricOption,
	metricValueOf,
	pickedMetric,
	readMetricKeys,
	unaskedMetrics,
} from "../../kit/query-builder/metric-options"
import type { EditorState } from "./editor-state"
import { Message } from "./message"
import type { Model } from "./model"

// `useWidgetBuilderData`'s metric list: one page of the org's metrics for what the picker searched,
// each name and type once, fetched while a query reads metrics.

export const FetchMetricOptions = Command.define("FetchWidgetEditorMetricOptions", {
	args: { search: Schema.String },
	messages: [Message.CompletedFetchMetricOptions],
	execute: ({ search }) =>
		listMetricOptions(search).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMetricOptions({ search, result })),
		),
})

/** The picked metric's data-point and resource keys over the last 24 h, read together. */
export const FetchMetricKeys = Command.define("FetchWidgetEditorMetricKeys", {
	args: { metricName: Schema.String, metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES) },
	messages: [Message.CompletedFetchMetricKeys],
	execute: (metric) =>
		readMetricKeys(metric).pipe(
			Effect.result,
			Effect.map((result) =>
				Message.CompletedFetchMetricKeys({ metric: metricValueOf(metric), result }),
			),
		),
})

const metricsQueriesOf = (state: EditorState | null) =>
	Arr.flatMap(state?.queries ?? [], (query) => (query.dataSource === "metrics" ? [query] : []))

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
	const missing = unaskedMetrics(queries, model.metricKeysRequested)
	return {
		model: {
			...model,
			metricRequested: model.metricSearch,
			metricKeysRequested: [...model.metricKeysRequested, ...Arr.map(missing, metricValueOf)],
		},
		commands: [...list, ...Arr.map(missing, (metric) => FetchMetricKeys(metric))],
	}
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
		queries: Arr.map(state.queries, (query) =>
			query.dataSource === "metrics" && query.metricName === ""
				? applyQueryChange(query, change)
				: query,
		),
	}
}
