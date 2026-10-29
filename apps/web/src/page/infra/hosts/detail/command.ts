import { hostDetailSummary, hostInfraTimeseries } from "@maple/web-data/warehouse/infra"
import { Effect, Layer, Schema } from "effect"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import { MountLinkedCursor } from "../../../../charts/linked-cursor"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { toLoadFailure } from "../../../../data/load-failure"
import { MountNetworkAutoRetry } from "../../../../ui/error-state"
import * as Frame from "../../kit/frame"
import { HostDetailDefinition } from "./definition"
import { HostMetric, Message } from "./message"

export const SummaryInput = Schema.Struct({
	hostName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type SummaryInput = typeof SummaryInput.Type

export const FetchSummary = HostDetailDefinition.makeCommand("FetchInfraHostSummary", {
	args: { key: Schema.String, input: SummaryInput },
	messages: [Message.CompletedFetchSummary],
	handler: function* () {
		return ({ key, input }) =>
			hostDetailSummary({ data: input }).pipe(
				Effect.map((response) => response.data),
				Effect.mapError(toLoadFailure),
				Effect.result,
				Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
			)
	},
})

export const SeriesInput = Schema.Struct({
	hostName: Schema.String,
	metric: HostMetric,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type SeriesInput = typeof SeriesInput.Type

export const FetchSeries = HostDetailDefinition.makeCommand("FetchInfraHostSeries", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchSeries],
	handler: function* () {
		return ({ key, input }) =>
			hostInfraTimeseries({ data: input }).pipe(
				Effect.map((response) => ({ rows: response.data, unit: response.unit })),
				Effect.mapError(toLoadFailure),
				Effect.result,
				Effect.map((result) => Message.CompletedFetchSeries({ metric: input.metric, key, result })),
			)
	},
})

/** The frame's resolved window, brought back as a page Message so the update can read the context. */
export const RelayResolvedWindow = HostDetailDefinition.makeCommand("RelayInfraHostResolvedWindow", {
	args: { mode: Frame.RequestMode },
	messages: [Message.ResolvedFrameWindow],
	handler: function* () {
		return ({ mode }) => Effect.succeed(Message.ResolvedFrameWindow({ mode }))
	},
})

/** The page's handlers, plus the shared chart runtime, theme, linked cursor and auto-retry effects it starts. */
export const EffectsLayer = Layer.mergeAll(
	FetchSummary.layer,
	FetchSeries.layer,
	RelayResolvedWindow.layer,
	LoadChartRuntime.layer,
	ResolveThemeColors.layer,
	MountLinkedCursor.layer,
	MountNetworkAutoRetry.layer,
)
