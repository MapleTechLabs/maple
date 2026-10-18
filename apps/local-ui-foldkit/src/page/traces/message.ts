import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { TraceFacets, TracePages, TraceRow } from "./model"

/** A sidebar facet the list takes one value of: its URL param. */
export const FacetParam = Schema.Literals(["env", "ns", "service", "span", "method", "status"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchTraces: { key: Schema.String, data: TracePages, fetchedAtMs: Schema.Number },
	FailedFetchTraces: { key: Schema.String, failure: LoadFailure },
	ClickedLoadMore: {},
	SucceededFetchNextPage: { key: Schema.String, page: Schema.Array(TraceRow) },
	FailedFetchNextPage: { key: Schema.String, failure: LoadFailure },
	SucceededFetchFacets: { key: Schema.String, facets: TraceFacets },
	FailedFetchFacets: { key: Schema.String, failure: LoadFailure },
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedSearch: { text: Schema.String },
	ClickedClearSearch: {},
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledErrorsOnly: {},
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ChangedDurationDraft: { min: Schema.String, max: Schema.String },
	CommittedDurationDraft: {},
	ElapsedDurationDebounce: { version: Schema.Number },
	AppliedDuration: { min: Schema.NullOr(Schema.Number), max: Schema.NullOr(Schema.Number) },
	ClickedClearFilters: {},
	ClickedExitSpanScope: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
