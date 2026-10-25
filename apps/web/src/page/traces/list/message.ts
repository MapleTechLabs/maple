import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as Dialog from "../../../ui/dialog"
import { AutocompleteLookup, LookupNames } from "../../kit/autocomplete-lookups"
import { SignalPresences } from "../../kit/signal-presence"
import { Message as DetailMessage } from "../detail/message"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { TracesFacets, TracesPage, VirtualRow } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (unsnapped window, revalidate). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The sidebar's facets, by their include param. */
export const Facet = Schema.Literals([
	"deploymentEnvs",
	"namespaces",
	"services",
	"spanNames",
	"httpMethods",
	"httpStatusCodes",
])
export type Facet = typeof Facet.Type

export const ChipId = Schema.String

export const SortKey = Schema.Literals(["timestamp", "durationMs"])
export type SortKey = typeof SortKey.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: {
		window: TimeWindow,
		nowMs: Schema.Number,
		mode: RequestMode,
		timeZone: Schema.String,
	},
	CompletedFetchFacets: result(TracesFacets),
	CompletedFetchFirstPage: result(TracesPage),
	/** A later page; `key` is the first page's key it continues. */
	CompletedFetchNextPage: { ...result(TracesPage), generation: Schema.Number, offset: Schema.Number },
	ChangedVirtualWindow: { rows: Schema.Array(VirtualRow), totalSize: Schema.Number },
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedClearNamespacePin: {},
	ToggledHasError: {},
	ToggledRootOnly: {},
	ToggledHideNoise: {},
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	ClickedClearSidebarFilters: {},
	ChangedDurationDraft: { min: Schema.String, max: Schema.String },
	ElapsedDurationDebounce: { version: Schema.Number },
	CommittedDurationDraft: {},
	AppliedDurationRange: { min: Schema.UndefinedOr(Schema.Number), max: Schema.UndefinedOr(Schema.Number) },
	RemovedFilterChip: { id: ChipId },
	ClickedClearAllChips: {},
	ClickedClearWhereClause: {},
	ClickedSort: { key: SortKey },
	ClickedShowNoise: {},
	ClickedClearExclusions: {},
	ClickedClearFilters: {},
	ClickedWidenRange: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	ClickedPeekRow: { index: Schema.Number },
	ClickedPeekStep: { step: Schema.Literals([1, -1]) },
	ClickedOpenTrace: {},
	/** `isMobile`: below `md` the peek is off (`peekEnabled = !isMobile`), read when pressed. */
	PressedListKey: { key: Schema.String, isMobile: Schema.Boolean },
	/** Enter on a row below `md`: the trace page itself (`navigate(traceLink(trace))`). */
	PressedOpenRow: { index: Schema.Number },
	GotPeekMessage: { message: DetailMessage },
	GotPeekDialogMessage: { message: Dialog.Message },
	ClickedAdvancedFilter: {},
	GotAdvancedDialogMessage: { message: Dialog.Message },
	EditedAdvanced: { value: Schema.String, cursor: Schema.Number },
	FocusedAdvanced: { cursor: Schema.Number },
	BlurredAdvanced: {},
	MovedAdvancedCursor: { cursor: Schema.Number },
	PressedAdvancedKey: { key: Schema.String },
	ClickedAdvancedSuggestion: { index: Schema.Number },
	SubmittedAdvanced: {},
	ClickedClearAdvanced: {},
	CompletedAdvancedLookup: {
		key: Schema.String,
		lookup: AutocompleteLookup,
		result: Schema.Result(LookupNames, LoadFailure),
	},
	CompletedPlaceAdvancedCursor: {},
})
export type Message = typeof Message.Type
