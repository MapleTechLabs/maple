import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { WorkloadFacets, WorkloadRows } from "./model"

export const WorkloadKindSchema = Schema.Literals(["deployment", "statefulset", "daemonset", "job"])
export const WorkloadScope = Schema.Literals(["saturated", "elevated", "stale"])
export type WorkloadScope = typeof WorkloadScope.Type
export const Facet = Schema.Literals(["workloadNames", "namespaces", "clusters", "environments", "computeTypes"])
export type Facet = typeof Facet.Type
export const WorkloadSortKey = Schema.Literals([
	"workloadName",
	"podCount",
	"restarts",
	"peakCpuLimitPct",
	"peakMemoryLimitPct",
	"lastSeen",
])
export type WorkloadSortKey = typeof WorkloadSortKey.Type

export const Message = defineMessageUnion({
	CompletedFetchWorkloads: { key: Schema.String, result: Schema.Result(WorkloadRows, LoadFailure) },
	CompletedFetchFacets: { key: Schema.String, result: Schema.Result(WorkloadFacets, LoadFailure) },
	ChangedQuery: { value: Schema.String },
	ChangedScope: { scope: Schema.optional(WorkloadScope) },
	ChangedKind: { kind: WorkloadKindSchema },
	ClickedClearSearch: {},
	ClickedSort: { key: WorkloadSortKey },
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedClearFilters: {},
	ClickedRetryWorkloads: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotFrameMessage: { message: Frame.Message },
	GotInstallMessage: { message: InstallModal.Message },
})
export type Message = typeof Message.Type
