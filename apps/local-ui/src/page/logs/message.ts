import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import * as Tooltip from "@maple/web/ui/tooltip"
import * as ToggleGroup from "@maple/web/ui/toggle-group"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { Message as LogSheetMessage } from "../kit/log-sheet/message"
import { ChipRef, FacetOption, LocalLog, LogPages, LogPatterns, LogPattern, Viewport } from "./model"

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
	ChangedViewport: { viewport: Viewport },
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
	ClickedLog: { log: LocalLog },
	ClickedChip: { text: Schema.String },
	EnteredChip: { chip: ChipRef },
	FocusedChip: { chip: ChipRef },
	LeftChip: { chip: ChipRef },
	BlurredChip: { chip: ChipRef },
	PressedChipEscape: { chip: ChipRef },
	EnteredChipCard: {},
	LeftChipCard: {},
	ElapsedChipDelay: { generation: Schema.Number },
	PlacedChipCard: {},
	ClickedChipJson: {},
	GotChipJsonTooltipMessage: { message: Tooltip.Message },
	CompletedCopyChip: {},
	GotLogSheetMessage: { message: LogSheetMessage },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
