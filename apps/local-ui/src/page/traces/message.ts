import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { CopyMessage } from "../kit/copies"
import { TraceFacets, TracePages, TraceRow } from "./model"

/** A sidebar facet the list takes one value of: its URL param. */
export const FacetParam = Schema.Literals(["env", "ns", "service", "span", "method", "status"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchTraces: { key: Schema.String, data: TracePages, fetchedAtMs: Schema.Number },
	FailedFetchTraces: { key: Schema.String, failure: LoadFailure },
	/** The result cache held this key (or an older window of its view) before the fetch ran. */
	FoundCachedTraces: { key: Schema.String, cached: CachedOf(TracePages) },
	ClickedLoadMore: {},
	SucceededFetchNextPage: { key: Schema.String, generation: Schema.Number, page: Schema.Array(TraceRow) },
	FailedFetchNextPage: { key: Schema.String, generation: Schema.Number, failure: LoadFailure },
	SucceededFetchFacets: { key: Schema.String, facets: TraceFacets, fetchedAtMs: Schema.Number },
	FailedFetchFacets: { key: Schema.String, failure: LoadFailure },
	FoundCachedFacets: { key: Schema.String, cached: CachedOf(TraceFacets) },
	ClickedRefresh: {},
	ClickedOpenFilters: {},
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
	/** A copy fact from the empty state's connect guide, carrying the button's id. */
	ReceivedCopyMessage: { message: CopyMessage },
	/** The root saw the fragment change under the open page: sync the search, load what it needs. */
	InformedOfLocationChange: {},
})
export type Message = typeof Message.Type
