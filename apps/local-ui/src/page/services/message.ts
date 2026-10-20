import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { Catalog } from "./model"

/** The two single-select facets: their URL params. */
export const FacetParam = Schema.Literals(["env", "ns"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchCatalog: { key: Schema.String, catalog: Catalog, fetchedAtMs: Schema.Number },
	FailedFetchCatalog: { key: Schema.String, failure: LoadFailure },
	/** The result cache held this slice (or an older window of it) before the fetch ran. */
	FoundCachedCatalog: { key: Schema.String, cached: CachedOf(Catalog) },
	ClickedRefresh: {},
	ClickedOpenFilters: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedSearch: { text: Schema.String },
	ClickedClearSearch: {},
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ClickedClearFacets: {},
	ClickedClearFilters: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
