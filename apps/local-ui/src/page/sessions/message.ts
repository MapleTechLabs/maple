import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { SessionFacets, SessionPages, SessionRow } from "./model"

/** A sidebar facet the list takes one value of: its URL param. */
export const FacetParam = Schema.Literals(["service", "browser", "device"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchSessions: { key: Schema.String, data: SessionPages, fetchedAtMs: Schema.Number },
	FailedFetchSessions: { key: Schema.String, failure: LoadFailure },
	/** The result cache held this key (or an older window of its view) before the fetch ran. */
	FoundCachedSessions: { key: Schema.String, cached: CachedOf(SessionPages) },
	ClickedLoadMore: {},
	SucceededFetchNextPage: { key: Schema.String, generation: Schema.Number, page: Schema.Array(SessionRow) },
	FailedFetchNextPage: { key: Schema.String, generation: Schema.Number, failure: LoadFailure },
	SucceededFetchFacets: { key: Schema.String, facets: SessionFacets, fetchedAtMs: Schema.Number },
	FailedFetchFacets: { key: Schema.String, failure: LoadFailure },
	FoundCachedFacets: { key: Schema.String, cached: CachedOf(SessionFacets) },
	ClickedRefresh: {},
	ClickedOpenFilters: {},
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
	/** The root's `locationChanged`: the hash moved while this page stayed open. */
	InformedOfLocationChange: {},
})
export type Message = typeof Message.Type
