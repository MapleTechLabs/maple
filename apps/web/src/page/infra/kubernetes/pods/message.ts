import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as Peek from "../peek/message"
import { PodsPage, RestartRows } from "../pod-data"
import { PodCounts, PodFacets } from "./model"

export const PodScope = Schema.Literals(["saturated", "elevated", "unbounded", "ended"])
export type PodScope = typeof PodScope.Type

export const PodSortKey = Schema.Literals(["saturation", "cpuUsage", "cpuLimitPct", "memoryLimitPct", "podName", "lastSeen"])

export const Facet = Schema.Literals([
	"namespaces",
	"podNames",
	"nodeNames",
	"clusters",
	"deployments",
	"statefulsets",
	"daemonsets",
	"jobs",
	"environments",
	"computeTypes",
])
export type Facet = typeof Facet.Type

export const FilterParam = Schema.Literals([
	"namespaces",
	"podNames",
	"nodeNames",
	"clusters",
	"deployments",
	"statefulsets",
	"daemonsets",
	"jobs",
	"environments",
	"computeTypes",
	"excludedNamespaces",
	"excludedPodNames",
	"excludedNodeNames",
	"excludedClusters",
	"excludedDeployments",
	"excludedStatefulsets",
	"excludedDaemonsets",
	"excludedJobs",
	"excludedEnvironments",
	"excludedComputeTypes",
])
export type FilterParam = typeof FilterParam.Type

export const Message = defineMessageUnion({
	CompletedFetchPods: { key: Schema.String, result: Schema.Result(PodsPage, LoadFailure) },
	CompletedFetchRestarts: { key: Schema.String, result: Schema.Result(RestartRows, LoadFailure) },
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(PodCounts, LoadFailure) },
	CompletedFetchFacets: { key: Schema.String, result: Schema.Result(PodFacets, LoadFailure) },
	ElapsedSearchDebounce: { query: Schema.String },
	ChangedQuery: { value: Schema.String },
	ChangedScope: { scope: Schema.optional(PodScope) },
	ClickedSort: { key: PodSortKey },
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	ClickedClearFilters: {},
	RemovedFilterChip: { param: FilterParam },
	ClickedPage: { direction: Schema.Literals([1, -1]) },
	ClickedRetryPods: {},
	ClickedShowEnded: {},
	/** `MountPodPeek`: a plain row click. */
	ClickedPeekRow: { key: Schema.String },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotFrameMessage: { message: Frame.Message },
	GotInstallMessage: { message: InstallModal.Message },
	GotPeekMessage: { message: Peek.Message },
})
export type Message = typeof Message.Type
