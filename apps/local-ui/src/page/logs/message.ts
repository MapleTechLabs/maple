import * as CopyButton from "@maple/views/ui/copy-button"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import { LogsViewPreferences } from "@maple/views/ui/logs/viewer"
import * as Popover from "@maple/views/ui/popover"
import * as Tooltip from "@maple/views/ui/tooltip"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as LogSheet from "@maple/views/logs/log-sheet"
import { FacetOption, LocalLog, LogPages, LogPatterns, LogPattern } from "./model"

export const FacetParam = Schema.Literals(["severity", "service"])
export type FacetParam = typeof FacetParam.Type

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchLogs: { key: Schema.String, data: LogPages, fetchedAtMs: Schema.Number },
	FailedFetchLogs: { key: Schema.String, failure: LoadFailure },
	/** The result cache held this key (or an older window of its view) before the fetch ran. */
	FoundCachedLogs: { key: Schema.String, cached: CachedOf(LogPages) },
	SucceededFetchNextPage: { key: Schema.String, generation: Schema.Number, page: Schema.Array(LocalLog) },
	FailedFetchNextPage: { key: Schema.String, generation: Schema.Number, failure: LoadFailure },
	SucceededFetchPatterns: { key: Schema.String, data: LogPatterns, fetchedAtMs: Schema.Number },
	FailedFetchPatterns: { key: Schema.String, failure: LoadFailure },
	FoundCachedPatterns: { key: Schema.String, cached: CachedOf(LogPatterns) },
	SucceededFetchServices: { key: Schema.String, options: Schema.Array(FacetOption), fetchedAtMs: Schema.Number },
	FailedFetchServices: { key: Schema.String, failure: LoadFailure },
	FoundCachedServices: { key: Schema.String, cached: CachedOf(Schema.Array(FacetOption)) },
	SucceededFetchSeverities: { key: Schema.String, options: Schema.Array(FacetOption), fetchedAtMs: Schema.Number },
	FailedFetchSeverities: { key: Schema.String, failure: LoadFailure },
	FoundCachedSeverities: { key: Schema.String, cached: CachedOf(Schema.Array(FacetOption)) },
	GotStreamMessage: { message: LogsStream.Message },
	ClickedRefresh: {},
	ClickedOpenFilters: {},
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
	/** An attribute filter's chip was removed. */
	RemovedAttributeFilter: {
		source: Schema.Literals(["log", "resource"]),
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
	ToggledColumn: { key: Schema.String },
	ClickedWrap: {},
	ClickedDensity: {},
	CompletedReadPreferences: { preferences: LogsViewPreferences },
	CompletedSavePreferences: {},
	GotToolbarTooltipMessage: { message: Tooltip.Message },
	GotColumnsPopoverMessage: { message: Popover.Message },
	GotLogSheetMessage: { message: LogSheet.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
