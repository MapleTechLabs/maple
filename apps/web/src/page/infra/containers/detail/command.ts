import { containerDetailSummary, containerInfraTimeseries } from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { Message } from "./message"
import { ContainerMetric } from "./model"

export const SummaryInput = Schema.Struct({
	containerName: Schema.String,
	hostName: Schema.optional(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type SummaryInput = typeof SummaryInput.Type

export const FetchSummary = Command.define("FetchInfraContainerSummary", {
	args: { key: Schema.String, input: SummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, input }) =>
		containerDetailSummary({ data: input }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

export const SeriesInput = Schema.Struct({
	containerName: Schema.String,
	hostName: Schema.optional(Schema.String),
	metric: ContainerMetric,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type SeriesInput = typeof SeriesInput.Type

export const FetchSeries = Command.define("FetchInfraContainerSeries", {
	args: { key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchSeries],
	execute: ({ key, input }) =>
		containerInfraTimeseries({ data: input }).pipe(
			Effect.map((response) => ({ rows: response.data, unit: response.unit })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSeries({ metric: input.metric, key, result })),
		),
})
