import { CachedOf } from "../../data/cached"
import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { ErrorsFacets, ErrorsSummary, ErrorTrace, ErrorTypeRow } from "./fetch"

export const FacetParam = Schema.Literals(["service", "env"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchSummary: {
		key: Schema.String,
		summary: Schema.NullOr(ErrorsSummary),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchSummary: { key: Schema.String, failure: LoadFailure },
	/** The result cache held a key (or an older window of its view) before the fetch ran. */
	FoundCachedSummary: { key: Schema.String, cached: CachedOf(Schema.NullOr(ErrorsSummary)) },
	SucceededFetchByType: {
		key: Schema.String,
		rows: Schema.Array(ErrorTypeRow),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchByType: { key: Schema.String, failure: LoadFailure },
	FoundCachedByType: { key: Schema.String, cached: CachedOf(Schema.Array(ErrorTypeRow)) },
	SucceededFetchFacets: { key: Schema.String, facets: ErrorsFacets, fetchedAtMs: Schema.Number },
	FailedFetchFacets: { key: Schema.String, failure: LoadFailure },
	FoundCachedFacets: { key: Schema.String, cached: CachedOf(ErrorsFacets) },
	ClickedErrorType: { fingerprintHash: Schema.String },
	SucceededFetchTraces: {
		fingerprintHash: Schema.String,
		key: Schema.String,
		traces: Schema.Array(ErrorTrace),
		fetchedAtMs: Schema.Number,
	},
	FoundCachedTraces: {
		fingerprintHash: Schema.String,
		key: Schema.String,
		cached: CachedOf(Schema.Array(ErrorTrace)),
	},
	FailedFetchTraces: { fingerprintHash: Schema.String, key: Schema.String, failure: LoadFailure },
	ClickedRetryTraces: { fingerprintHash: Schema.String },
	ClickedRefresh: {},
	ClickedOpenFilters: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ToggledRootOnly: {},
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ClickedClearFilters: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
