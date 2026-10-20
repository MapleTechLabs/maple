import {
	ContainerFacetsResponse,
	ContainersSummaryResponse,
	ListContainersResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraContainersSearch } from "../../../../route/search"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"

// `/infra/containers`.

export const ContainersPage = Schema.Struct(ListContainersResponse.fields)
export type ContainersPage = typeof ContainersPage.Type
export type ContainerRow = ContainersPage["data"][number]

export const ContainerCounts = Schema.Struct(ContainersSummaryResponse.fields)
export type ContainerCounts = typeof ContainerCounts.Type

export const ContainerFacets = ContainerFacetsResponse.fields.data
export type ContainerFacets = typeof ContainerFacets.Type

/** `useResettingPage`: the index snaps back to 0 whenever the reset key (filters, search, sort) changes. */
export const PageIndex = Schema.Struct({ resetKey: Schema.String, index: Schema.Number })

export const Model = Schema.Struct({
	search: InfraContainersSearch,
	frame: Frame.Model,
	/** `useDebouncedValue(search.q, 300)`: the name filter the server sees. */
	debouncedQuery: Schema.String,
	page: PageIndex,
	containers: KeyedSchema(ContainersPage, LoadFailure),
	summary: KeyedSchema(ContainerCounts, LoadFailure),
	facets: KeyedSchema(ContainerFacets, LoadFailure),
	filterSections: FilterSections.Model,
	install: InstallModal.Model,
})
export type Model = typeof Model.Type
