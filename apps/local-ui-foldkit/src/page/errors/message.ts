import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { ErrorsFacets, ErrorsSummary, ErrorTrace, ErrorTypeRow } from "./fetch"

export const FacetParam = Schema.Literals(["service", "env"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchSummary: { key: Schema.String, summary: Schema.NullOr(ErrorsSummary) },
	FailedFetchSummary: { key: Schema.String, failure: LoadFailure },
	SucceededFetchByType: { key: Schema.String, rows: Schema.Array(ErrorTypeRow), fetchedAtMs: Schema.Number },
	FailedFetchByType: { key: Schema.String, failure: LoadFailure },
	SucceededFetchFacets: { key: Schema.String, facets: ErrorsFacets },
	FailedFetchFacets: { key: Schema.String, failure: LoadFailure },
	ClickedErrorType: { fingerprintHash: Schema.String },
	SucceededFetchTraces: { fingerprintHash: Schema.String, key: Schema.String, traces: Schema.Array(ErrorTrace) },
	FailedFetchTraces: { fingerprintHash: Schema.String, key: Schema.String, failure: LoadFailure },
	ClickedRetryTraces: { fingerprintHash: Schema.String },
	ClickedRefresh: {},
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
