import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { NodeFacets, NodeRows } from "./model"

export const NodeStatus = Schema.Literals(["active", "idle", "ended"])
export const Facet = Schema.Literals(["nodeNames", "clusters", "environments"])
export type Facet = typeof Facet.Type
export const NodeSortKey = Schema.Literals(["nodeName", "cpuUtilization", "memoryUtilization", "uptime", "lastSeen"])
export type NodeSortKey = typeof NodeSortKey.Type

export const Message = defineMessageUnion({
	CompletedFetchNodes: { key: Schema.String, result: Schema.Result(NodeRows, LoadFailure) },
	CompletedFetchFacets: { key: Schema.String, result: Schema.Result(NodeFacets, LoadFailure) },
	ChangedQuery: { value: Schema.String },
	ChangedStatus: { status: Schema.optional(NodeStatus) },
	ClickedClearSearch: {},
	ClickedSort: { key: NodeSortKey },
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedClearFilters: {},
	ClickedRetryNodes: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotFrameMessage: { message: Frame.Message },
	GotInstallMessage: { message: InstallModal.Message },
})
export type Message = typeof Message.Type
