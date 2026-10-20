import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../kit/series"
import {
	fetchPodSeries,
	fetchPodSummary,
	fetchRestarts,
	PodMetric,
	PodSeriesInput,
	PodSummary,
	PodSummaryInput,
	RestartRows,
	RestartsInput,
} from "../pod-data"

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(PodSummary, LoadFailure) },
	CompletedFetchRestarts: { key: Schema.String, result: Schema.Result(RestartRows, LoadFailure) },
	CompletedFetchSeries: { metric: PodMetric, key: Schema.String, result: SeriesResult },
	ClickedMetric: { metric: PodMetric },
	ClickedRetrySummary: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { metric: PodMetric, message: Chart.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

export const FetchSummary = Command.define("FetchInfraPodSummary", {
	args: { key: Schema.String, input: PodSummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, input }) =>
		Effect.map(fetchPodSummary(input), (result) => Message.CompletedFetchSummary({ key, result })),
})

export const FetchRestarts = Command.define("FetchInfraPodDetailRestarts", {
	args: { key: Schema.String, input: RestartsInput },
	messages: [Message.CompletedFetchRestarts],
	execute: ({ key, input }) =>
		Effect.map(fetchRestarts(input), (result) => Message.CompletedFetchRestarts({ key, result })),
})

export const FetchSeries = Command.define("FetchInfraPodSeries", {
	args: { key: Schema.String, input: PodSeriesInput },
	messages: [Message.CompletedFetchSeries],
	execute: ({ key, input }) =>
		Effect.map(fetchPodSeries(input), (result) =>
			Message.CompletedFetchSeries({ metric: input.metric, key, result }),
		),
})
