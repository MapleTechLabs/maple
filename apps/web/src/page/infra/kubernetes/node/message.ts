import { nodeDetailSummary, nodeInfraTimeseries } from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure, toLoadFailure } from "../../../../data/load-failure"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../kit/series"
import { fetchPods, PodsInput, PodsPage } from "../pod-data"
import { NodeMetric, NodeSummary } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(NodeSummary, LoadFailure) },
	CompletedFetchPods: { key: Schema.String, result: Schema.Result(PodsPage, LoadFailure) },
	CompletedFetchSeries: { metric: NodeMetric, key: Schema.String, result: SeriesResult },
	ClickedMetric: { metric: NodeMetric },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { metric: NodeMetric, message: Chart.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

export const SummaryInput = Schema.Struct({ nodeName: Schema.String, startTime: Schema.String, endTime: Schema.String })

export const FetchSummary = Command.define("FetchInfraNodeSummary", {
	args: { key: Schema.String, input: SummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, input }) =>
		nodeDetailSummary({ data: input }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

export const FetchPods = Command.define("FetchInfraNodePods", {
	args: { key: Schema.String, input: PodsInput },
	messages: [Message.CompletedFetchPods],
	execute: ({ key, input }) => Effect.map(fetchPods(input), (result) => Message.CompletedFetchPods({ key, result })),
})

export const SeriesInput = Schema.Struct({
	nodeName: Schema.String,
	metric: NodeMetric,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type SeriesInput = typeof SeriesInput.Type

export const FetchSeries = Command.define("FetchInfraNodeSeries", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchSeries],
	execute: ({ key, input }) =>
		nodeInfraTimeseries({ data: input }).pipe(
			Effect.map((response) => ({ rows: response.data, unit: response.unit })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSeries({ metric: input.metric, key, result })),
		),
})
