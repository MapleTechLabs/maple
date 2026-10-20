import { ListNodesResponse, NodeFacetsResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraKubernetesNodesSearch } from "../../../../route/search"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { SortState } from "../../../kit/table-sort"

// `/infra/kubernetes/nodes`.

export const NodeRows = ListNodesResponse.fields.data
export type NodeRow = ListNodesResponse["data"][number]
export const NodeFacets = NodeFacetsResponse.fields.data
export type NodeFacets = typeof NodeFacets.Type

/** The list query returns the most recently seen N nodes; the toolbar says so at the cap. */
export const NODE_LIST_LIMIT = 200

export const Model = Schema.Struct({
	search: InfraKubernetesNodesSearch,
	frame: Frame.Model,
	nodes: KeyedSchema(NodeRows, LoadFailure),
	facets: KeyedSchema(NodeFacets, LoadFailure),
	/** `useTableSort` in `NodeTable`: initial key `cpuUtilization`, descending. */
	sort: SortState,
	filterSections: FilterSections.Model,
	install: InstallModal.Model,
})
export type Model = typeof Model.Type
