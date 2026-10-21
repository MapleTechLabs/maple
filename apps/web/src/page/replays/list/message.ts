import { SessionTag } from "@maple/domain/query-engine"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { SignalPresences } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { VirtualWindow } from "../kit/virtualize"
import { ReplaysFacets, ReplaysPage } from "./model"
import { HistogramMessage } from "../../../ui/filters/range-histogram"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The single-value sidebar facets, by their URL param. */
export const Facet = Schema.Literals(["service", "browser", "country", "deviceType", "group", "page"])
export type Facet = typeof Facet.Type

export const Range = Schema.Literals(["duration", "active"])
export type Range = typeof Range.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

const Bound = Schema.UndefinedOr(Schema.Number)

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchFirstPage: result(ReplaysPage),
	CompletedFetchNextPage: { ...result(ReplaysPage), generation: Schema.Number, cursor: Schema.String },
	CompletedFetchFacets: result(ReplaysFacets),
	ReachedListEnd: {},
	ChangedVirtualWindow: { window: VirtualWindow },
	ClickedLoadMore: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedRetryList: {},
	ChangedQuery: { value: Schema.String },
	CompletedQueryDebounce: { generation: Schema.Number },
	ClickedClearQuery: {},
	ToggledErrorsOnly: {},
	ToggledEngagedOnly: {},
	ToggledTag: { tag: Schema.String },
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ChangedRangeDraft: { range: Range, min: Schema.String, max: Schema.String },
	CompletedDraftDebounce: { version: Schema.Number },
	CommittedRangeDraft: { range: Range },
	AppliedRange: { range: Range, min: Bound, max: Bound },
	GotHistogramMessage: { range: Range, message: HistogramMessage },
	ChangedUserText: { value: Schema.String },
	ChangedUserIdText: { value: Schema.String },
	SubmittedUser: {},
	SubmittedUserId: {},
	ClickedClearUser: {},
	ClickedClearUserId: {},
	ClickedClearVisitor: {},
	ClickedClearSidebarFilters: {},
	ClickedClearFilters: {},
	ClickedSession: { sessionId: Schema.String, startTime: Schema.String },
	ToggledRun: { key: Schema.String },
	ClickedRowTag: { tag: SessionTag },
	ClickedRowGroup: { group: Schema.String },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
