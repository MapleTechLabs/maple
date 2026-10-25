import { PodFacetsResponse, PodsSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraKubernetesPodsSearch } from "../../../../route/search"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as Peek from "../peek/model"
import { PodsPage, RestartRows } from "../pod-data"

// `/infra/kubernetes/pods`.

export const PodCounts = Schema.Struct(PodsSummaryResponse.fields)
export type PodCounts = typeof PodCounts.Type

export const PodFacets = PodFacetsResponse.fields.data
export type PodFacets = typeof PodFacets.Type

export const PageIndex = Schema.Struct({ resetKey: Schema.String, index: Schema.Number })

export const Model = Schema.Struct({
	search: InfraKubernetesPodsSearch,
	frame: Frame.Model,
	debouncedQuery: Schema.String,
	page: PageIndex,
	pods: KeyedSchema(PodsPage, LoadFailure),
	/** `PodTableWithRestarts`: the page's restarts, fetched beside the list. */
	restarts: KeyedSchema(RestartRows, LoadFailure),
	summary: KeyedSchema(PodCounts, LoadFailure),
	facets: KeyedSchema(PodFacets, LoadFailure),
	filterSections: FilterSections.Model,
	install: InstallModal.Model,
	/** `PodPeekSheet`, opened by `search.peek`. */
	peek: Peek.Model,
})
export type Model = typeof Model.Type
