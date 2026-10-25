import { getMetricSparklines, getMetricsSummary, listMetrics } from "@maple/web-data/warehouse/metrics"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveMetricsWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

const MetricType = Schema.Literals(QUERY_BUILDER_METRIC_TYPES)

/** `listMetricsResultAtom`'s input: what the grid and the table send. */
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
		Effect.mapError(toLoadFailure),
		Effect.result,
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
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
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
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSparklines({ slot, key, result })),
		),
})

/** `ToolbarSearch`'s `useDebouncedCallback(..., 300)`. */
export const DebounceSearch = Command.define("DebounceMetricsSearch", {
	args: { generation: Schema.Number },
	messages: [Message.CompletedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.CompletedSearchDebounce({ generation })),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteMetricsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

export const LoadSignalPresence = Command.define("LoadMetricsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
