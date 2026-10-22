import { getPodFacets, podsSummary, type PodsSummaryInput } from "@maple/web-data/warehouse/infra"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { fetchPods, fetchRestarts, PodsInput, RestartsInput } from "../pod-data"
import { Message } from "./message"

export const PAGE_SIZE = 50

export const FetchPods = Command.define("FetchInfraPods", {
	args: { key: Schema.String, input: PodsInput },
	messages: [Message.CompletedFetchPods],
	execute: ({ key, input }) =>
		Effect.map(fetchPods(input), (result) => Message.CompletedFetchPods({ key, result })),
})

export const FetchRestarts = Command.define("FetchInfraPodRestarts", {
	args: { key: Schema.String, input: RestartsInput },
	messages: [Message.CompletedFetchRestarts],
	execute: ({ key, input }) =>
		Effect.map(fetchRestarts(input), (result) => Message.CompletedFetchRestarts({ key, result })),
})

const StringList = Schema.optional(Schema.Array(Schema.String))

export const SummaryInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	clusters: StringList,
	environments: StringList,
	namespaces: StringList,
})

export const FetchSummary = Command.define("FetchInfraPodsSummary", {
	args: { key: Schema.String, input: SummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, input }) =>
		podsSummary({ data: input satisfies PodsSummaryInput }).pipe(
			Effect.map((counts) => ({
				livePods: counts.livePods,
				endedPods: counts.endedPods,
				saturatedPods: counts.saturatedPods,
				elevatedPods: counts.elevatedPods,
				unboundedPods: counts.unboundedPods,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

export const FetchFacets = Command.define("FetchInfraPodFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getPodFacets({ data: window }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const DebounceSearch = Command.define("DebounceInfraPodsSearch", {
	args: { query: Schema.String },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ query }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ query })),
})
