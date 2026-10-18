import * as AttributesPanel from "@maple/web-foldkit/ui/attributes/attributes-panel"
import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import * as ToggleGroup from "@maple/web-foldkit/ui/toggle-group"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { FacetOption, LocalLog, LogPages, LogPatterns, LogPattern, Viewport } from "./model"

export const FacetParam = Schema.Literals(["severity", "service"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchLogs: { key: Schema.String, data: LogPages, fetchedAtMs: Schema.Number },
	FailedFetchLogs: { key: Schema.String, failure: LoadFailure },
	SucceededFetchNextPage: { key: Schema.String, page: Schema.Array(LocalLog) },
	FailedFetchNextPage: { key: Schema.String, failure: LoadFailure },
	SucceededFetchPatterns: { key: Schema.String, data: LogPatterns, fetchedAtMs: Schema.Number },
	FailedFetchPatterns: { key: Schema.String, failure: LoadFailure },
	SucceededFetchServices: { key: Schema.String, options: Schema.Array(FacetOption) },
	FailedFetchServices: { key: Schema.String, failure: LoadFailure },
	SucceededFetchSeverities: { key: Schema.String, options: Schema.Array(FacetOption) },
	FailedFetchSeverities: { key: Schema.String, failure: LoadFailure },
	ChangedViewport: { viewport: Viewport },
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedSearch: { text: Schema.String },
	ClickedClearSearch: {},
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledFacetOption: { param: FacetParam, name: Schema.String },
	ClickedClearSidebarFilters: {},
	ClickedClearFilters: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	GotModeToggleMessage: { message: ToggleGroup.Message },
	ClickedPattern: { pattern: LogPattern },
	ClickedLog: { log: LocalLog },
	ClickedChip: { text: Schema.String },
	CompletedCopyChip: {},
	ClosedDetail: {},
	ToggledBodyExpanded: {},
	GotDetailTabsMessage: { message: Tabs.Message },
	GotDetailAttributesMessage: { message: AttributesPanel.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
