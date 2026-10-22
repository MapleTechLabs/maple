import {
	containersSummary,
	getContainerFacets,
	listContainers,
	type ContainersSummaryInput,
	type ListContainersInput,
} from "@maple/web-data/warehouse/infra"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { Message } from "./message"

/** `PAGE_SIZE`. */
export const PAGE_SIZE = 50

const StringList = Schema.optional(Schema.Array(Schema.String))

/** `ListContainersInput` as data, so it rides in a Command's args. */
export const ContainersInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	search: Schema.optional(Schema.String),
	containerNames: StringList,
	hostNames: StringList,
	images: StringList,
	composeProjects: StringList,
	composeServices: StringList,
	environments: StringList,
	excludedContainerNames: StringList,
	excludedHostNames: StringList,
	excludedImages: StringList,
	excludedComposeProjects: StringList,
	excludedComposeServices: StringList,
	excludedEnvironments: StringList,
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	sortBy: Schema.optional(Schema.Literals(["saturation", "cpuPct", "memoryPct", "containerName", "lastSeen"])),
	sortDir: Schema.optional(Schema.Literals(["asc", "desc"])),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
})
export type ContainersInput = typeof ContainersInput.Type

export const FetchContainers = Command.define("FetchInfraContainers", {
	args: { key: Schema.String, input: ContainersInput },
	messages: [Message.CompletedFetchContainers],
	execute: ({ key, input }) =>
		listContainers({ data: input satisfies ListContainersInput }).pipe(
			Effect.map(({ data, totalCount }) => ({ data, totalCount })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchContainers({ key, result })),
		),
})

export const SummaryInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	hostNames: StringList,
	environments: StringList,
})

export const FetchSummary = Command.define("FetchInfraContainersSummary", {
	args: { key: Schema.String, input: SummaryInput },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, input }) =>
		containersSummary({ data: input satisfies ContainersSummaryInput }).pipe(
			Effect.map((counts) => ({
				totalContainers: counts.totalContainers,
				saturatedContainers: counts.saturatedContainers,
				elevatedContainers: counts.elevatedContainers,
				staleContainers: counts.staleContainers,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

export const FetchFacets = Command.define("FetchInfraContainerFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getContainerFacets({ data: window }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

/** `useDebouncedValue(searchText, 300)`: the query lands after 300 ms of quiet. */
export const DebounceSearch = Command.define("DebounceInfraContainersSearch", {
	args: { query: Schema.String },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ query }) => Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ query })),
})
