import { AiSessionDetailsItem, AiSessionSortKey } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { HistogramMessage } from "../../../ui/filters/range-histogram"
import { SignalPresences } from "../../kit/signal-presence"
import { DetectedModel } from "../kit/detected-models"
import { VirtualWindow } from "../kit/virtualize"
import { Distributions, Facets, RangeKey, SessionsPage } from "./model"

/** `Load` on entry; `Refresh` from Reload (re-resolve the week, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The rail's counted list filters, by their URL param. */
export const ListFacet = Schema.Literals(["vendors", "services", "environments", "models", "agents", "tools"])
export type ListFacet = typeof ListFacet.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: {
		window: TimeWindow,
		tabWindow: TimeWindow,
		nowMs: Schema.Number,
		mode: RequestMode,
	},
	CompletedFetchFirstPage: result(SessionsPage),
	/** `offset` is where the page starts; an answer for an offset already filled is dropped. */
	CompletedFetchNextPage: { ...result(SessionsPage), offset: Schema.Number },
	CompletedFetchDetails: {
		detailsKey: Schema.String,
		sessionIds: Schema.Array(Schema.String),
		result: Schema.Result(Schema.Array(AiSessionDetailsItem), LoadFailure),
	},
	CompletedFetchFacets: result(Facets),
	CompletedFetchDistributions: result(Distributions),
	CompletedFetchTabSessions: result(Schema.Number),
	CompletedFetchTabTools: result(Schema.Number),
	CompletedDetectModels: { key: Schema.String, models: Schema.Array(DetectedModel) },
	PaintedTable: {},
	MountedFilterRail: {},
	ChangedListWindow: { window: VirtualWindow },
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ReachedListEnd: {},
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ChangedSearchInput: { value: Schema.String },
	ElapsedSearchDebounce: { version: Schema.Number },
	ToggledErrorsOnly: {},
	ClickedSort: { key: AiSessionSortKey },
	ClickedSessionRow: { url: Schema.String },
	ClickedClearFilters: {},
	ClickedClearAllFilters: {},
	ToggledFacetOption: { facet: ListFacet, name: Schema.String },
	ToggledGrouped: {},
	ChangedRangeDraft: { range: RangeKey, min: Schema.String, max: Schema.String },
	ElapsedRangeDebounce: { range: RangeKey, version: Schema.Number },
	CommittedRangeDraft: { range: RangeKey },
	AppliedRange: {
		range: RangeKey,
		min: Schema.UndefinedOr(Schema.Number),
		max: Schema.UndefinedOr(Schema.Number),
	},
	GotHistogramMessage: { range: RangeKey, message: HistogramMessage },
	GotFilterSectionsMessage: { message: FilterSections.Message },
})
export type Message = typeof Message.Type
