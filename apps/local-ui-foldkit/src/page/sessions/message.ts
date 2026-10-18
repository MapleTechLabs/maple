import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { SessionFacets, SessionPages, SessionRow } from "./model"

/** A sidebar facet the list takes one value of: its URL param. */
export const FacetParam = Schema.Literals(["service", "browser", "device"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchSessions: { key: Schema.String, data: SessionPages, fetchedAtMs: Schema.Number },
	FailedFetchSessions: { key: Schema.String, failure: LoadFailure },
	ClickedLoadMore: {},
	SucceededFetchNextPage: { key: Schema.String, page: Schema.Array(SessionRow) },
	FailedFetchNextPage: { key: Schema.String, failure: LoadFailure },
	SucceededFetchFacets: { key: Schema.String, facets: SessionFacets },
	FailedFetchFacets: { key: Schema.String, failure: LoadFailure },
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedSearch: { text: Schema.String },
	ClickedClearSearch: {},
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledErrorsOnly: {},
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ClickedClearFilters: {},
	ClickedClearAllFilters: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
