import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { ContainerCounts, ContainerFacets, ContainersPage } from "./model"

export const ContainerScope = Schema.Literals(["saturated", "elevated", "stale"])
export type ContainerScope = typeof ContainerScope.Type

export const ContainerSortKey = Schema.Literals([
	"saturation",
	"cpuPct",
	"memoryPct",
	"containerName",
	"lastSeen",
])
export type ContainerSortKey = typeof ContainerSortKey.Type

/** A facet by its include param. */
export const Facet = Schema.Literals([
	"containerNames",
	"images",
	"hostNames",
	"composeProjects",
	"composeServices",
	"environments",
])
export type Facet = typeof Facet.Type

export const FilterParam = Schema.Literals([
	"containerNames",
	"images",
	"hostNames",
	"composeProjects",
	"composeServices",
	"environments",
	"excludedContainerNames",
	"excludedImages",
	"excludedHostNames",
	"excludedComposeProjects",
	"excludedComposeServices",
	"excludedEnvironments",
])
export type FilterParam = typeof FilterParam.Type

export const Message = defineMessageUnion({
	CompletedFetchContainers: { key: Schema.String, result: Schema.Result(ContainersPage, LoadFailure) },
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(ContainerCounts, LoadFailure) },
	CompletedFetchFacets: { key: Schema.String, result: Schema.Result(ContainerFacets, LoadFailure) },
	ElapsedSearchDebounce: { query: Schema.String },
	ChangedQuery: { value: Schema.String },
	ChangedScope: { scope: Schema.optional(ContainerScope) },
	ClickedSort: { key: ContainerSortKey },
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	ClickedClearFilters: {},
	RemovedFilterChip: { param: FilterParam },
	ClickedPage: { direction: Schema.Literals([1, -1]) },
	ClickedRetryContainers: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotFrameMessage: { message: Frame.Message },
	GotInstallMessage: { message: InstallModal.Message },
})
export type Message = typeof Message.Type
