import { workloadDetailSummary, workloadInfraTimeseries } from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure, toLoadFailure } from "../../../../data/load-failure"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../kit/series"
import { fetchPods, PodsInput, PodsPage } from "../pod-data"
import { WorkloadKind, WorkloadMetric, WorkloadSummary } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(WorkloadSummary, LoadFailure) },
	CompletedFetchPods: { key: Schema.String, result: Schema.Result(PodsPage, LoadFailure) },
	CompletedFetchSeries: { id: Schema.String, key: Schema.String, result: SeriesResult },
	ClickedMetric: { metric: WorkloadMetric },
	ToggledGroupByPod: { isChecked: Schema.Boolean },
	ClickedRetrySummary: {},
	ClickedRetryPods: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { metric: WorkloadMetric, message: Chart.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

export const SummaryInput = Schema.Struct({
	kind: WorkloadKind,
	workloadName: Schema.String,
	namespace: Schema.optional(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type SummaryInput = typeof SummaryInput.Type

export const FetchSummary = Command.define("FetchInfraWorkloadSummary", {
	args: { key: Schema.String, input: SummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, input }) =>
		workloadDetailSummary({ data: input }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

export const FetchPods = Command.define("FetchInfraWorkloadPods", {
	args: { key: Schema.String, input: PodsInput },
	messages: [Message.CompletedFetchPods],
	execute: ({ key, input }) => Effect.map(fetchPods(input), (result) => Message.CompletedFetchPods({ key, result })),
})

export const SeriesInput = Schema.Struct({
	kind: WorkloadKind,
	workloadName: Schema.String,
	namespace: Schema.optional(Schema.String),
	metric: WorkloadMetric,
	groupByPod: Schema.Boolean,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type SeriesInput = typeof SeriesInput.Type

export const FetchSeries = Command.define("FetchInfraWorkloadSeries", {
	args: { id: Schema.String, key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchSeries],
	execute: ({ id, key, input }) =>
		workloadInfraTimeseries({ data: input }).pipe(
			Effect.map((response) => ({ rows: response.data, unit: response.unit })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSeries({ id, key, result })),
		),
})
