import { ListWorkloadsResponse, WorkloadFacetsResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraKubernetesWorkloadsSearch } from "../../../../route/search"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { SortState } from "../../../kit/table-sort"

// `/infra/kubernetes/workloads`.

export const WorkloadRows = ListWorkloadsResponse.fields.data
export type WorkloadRow = ListWorkloadsResponse["data"][number]
export const WorkloadFacets = WorkloadFacetsResponse.fields.data
export type WorkloadFacets = typeof WorkloadFacets.Type

export type WorkloadKind = "deployment" | "statefulset" | "daemonset" | "job"

/** The N least healthy workloads come back; the toolbar says so at the cap. */
export const WORKLOAD_LIST_LIMIT = 200

export const Model = Schema.Struct({
	search: InfraKubernetesWorkloadsSearch,
	frame: Frame.Model,
	workloads: KeyedSchema(WorkloadRows, LoadFailure),
	facets: KeyedSchema(WorkloadFacets, LoadFailure),
	/** `useTableSort` in `WorkloadTable`: no initial key (the server sorts worst first), resettable. */
	sort: SortState,
	filterSections: FilterSections.Model,
	install: InstallModal.Model,
})
export type Model = typeof Model.Type
