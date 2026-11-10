import { resolveWindowCommand } from "../../kit/time-frame"
import { reloadSpin, SEARCH_DEBOUNCE } from "@maple/views/data/timing"
import { getMetricSparklines, getMetricsSummary, listMetrics } from "@maple/web-data/warehouse/metrics"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo, settled } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message } from "./message"

export const ResolveWindow = resolveWindowCommand("ResolveMetricsWindow", Message.CompletedResolveWindow)

const MetricType = Schema.Literals(QUERY_BUILDER_METRIC_TYPES)

/** The metrics list input: what the grid and the table send. */
export const ListInput = Schema.Struct({
	search: Schema.optional(Schema.String),
	metricType: Schema.optional(MetricType),
	limit: Schema.Number,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type ListInput = typeof ListInput.Type

const fetchList = (input: ListInput) =>
	listMetrics({ data: input }).pipe(
		Effect.map((response) => response.data),
		settled,
	)

export const FetchCatalog = Command.define("FetchMetricsCatalog", {
	args: { key: Schema.String, input: ListInput },
	messages: [Message.CompletedFetchCatalog],
	execute: ({ key, input }) =>
		Effect.map(fetchList(input), (result) => Message.CompletedFetchCatalog({ key, result })),
})

export const FetchTable = Command.define("FetchMetricsTable", {
	args: { key: Schema.String, input: ListInput },
	messages: [Message.CompletedFetchTable],
	execute: ({ key, input }) =>
		Effect.map(fetchList(input), (result) => Message.CompletedFetchTable({ key, result })),
})

export const FetchSummary = Command.define("FetchMetricsSummary", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, window }) =>
		getMetricsSummary({ data: window }).pipe(
			Effect.map((response) => response.data),
			settleTo((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

export const SparklinesInput = Schema.Struct({
	metricType: MetricType,
	metricNames: Schema.Array(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type SparklinesInput = typeof SparklinesInput.Type

export const FetchSparklines = Command.define("FetchMetricSparklines", {
	args: { slot: Schema.String, key: Schema.String, input: SparklinesInput },
	messages: [Message.CompletedFetchSparklines],
	execute: ({ slot, key, input }) =>
		getMetricSparklines({ data: input }).pipe(
			Effect.map((response) => response.data),
			settleTo((result) => Message.CompletedFetchSparklines({ slot, key, result })),
		),
})

/** The toolbar search's debounce. */
export const DebounceSearch = Command.define("DebounceMetricsSearch", {
	args: { generation: Schema.Number },
	messages: [Message.CompletedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(SEARCH_DEBOUNCE), Message.CompletedSearchDebounce({ generation })),
})

export const CompleteReloadSpin = reloadSpin("CompleteMetricsReloadSpin", Message.CompletedReloadSpin)

export const LoadSignalPresence = Command.define("LoadMetricsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
