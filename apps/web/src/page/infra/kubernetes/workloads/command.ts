import { getWorkloadFacets, listWorkloads } from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { Message, WorkloadKindSchema } from "./message"

const StringList = Schema.optional(Schema.Array(Schema.String))

export const WorkloadsInput = Schema.Struct({
	kind: WorkloadKindSchema,
	startTime: Schema.String,
	endTime: Schema.String,
	workloadNames: StringList,
	namespaces: StringList,
	clusters: StringList,
	environments: StringList,
	computeTypes: StringList,
	limit: Schema.Number,
})
export type WorkloadsInput = typeof WorkloadsInput.Type

export const FetchWorkloads = Command.define("FetchInfraWorkloads", {
	args: { key: Schema.String, input: WorkloadsInput },
	messages: [Message.CompletedFetchWorkloads],
	execute: ({ key, input }) =>
		listWorkloads({ data: input }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWorkloads({ key, result })),
		),
})

export const FacetsInput = Schema.Struct({
	kind: WorkloadKindSchema,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type FacetsInput = typeof FacetsInput.Type

export const FetchFacets = Command.define("FetchInfraWorkloadFacets", {
	args: { key: Schema.String, input: FacetsInput },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, input }) =>
		getWorkloadFacets({ data: input }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})
