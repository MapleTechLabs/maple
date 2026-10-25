import { getNodeFacets, listNodes } from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { Message } from "./message"

export const NodesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	nodeNames: Schema.optional(Schema.Array(Schema.String)),
	clusters: Schema.optional(Schema.Array(Schema.String)),
	environments: Schema.optional(Schema.Array(Schema.String)),
	limit: Schema.Number,
})
export type NodesInput = typeof NodesInput.Type

export const FetchNodes = Command.define("FetchInfraNodes", {
	args: { key: Schema.String, input: NodesInput },
	messages: [Message.CompletedFetchNodes],
	execute: ({ key, input }) =>
		listNodes({ data: input }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchNodes({ key, result })),
		),
})

export const FetchFacets = Command.define("FetchInfraNodeFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getNodeFacets({ data: window }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})
