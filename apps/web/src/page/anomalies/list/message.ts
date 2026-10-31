import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as Tabs from "../../../ui/tabs"
import { SignalPresences } from "../../kit/signal-presence"
import { GroupKey, IncidentPage, StatusTab } from "./model"

/** The sidebar facets, each with its excluded twin in the URL. */
export const Facet = Schema.Literals(["severity", "signals", "services", "envs"])
export type Facet = typeof Facet.Type

/** A chip's URL param (`AnomalyFilterChipDescriptor.param`). */
export const FilterParam = Schema.Literals([
	"severity",
	"signals",
	"services",
	"envs",
	"excludedSeverity",
	"excludedSignals",
	"excludedServices",
	"excludedEnvs",
])
export type FilterParam = typeof FilterParam.Type

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchFirstPage: { key: Schema.String, result: Schema.Result(IncidentPage, LoadFailure) },
	ClickedLoadMore: {},
	/** `cursor` is the page it continues; a refresh in between moves the cursor and drops it. */
	CompletedLoadMore: { status: StatusTab, cursor: Schema.String, result: Schema.Result(IncidentPage, LoadFailure) },
	ClickedRetry: {},
	/** Each live tick reads the clock, so relative times age with the data. */
	TickedLiveRefresh: { nowMs: Schema.Number },
	ToggledLive: {},
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	RemovedFilterChip: { param: FilterParam },
	ClickedClearFilters: {},
	ClickedClearExclusions: {},
	ToggledGroup: { group: GroupKey },
	HoveredRow: { id: Schema.String },
	/** `useListNavigation`: j/k and the arrows move the focus, Enter opens it, Escape clears it. */
	PressedListKey: { key: Schema.Literals(["Next", "Previous", "Open", "Escape"]) },
	CompletedScrollRow: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	GotTabsMessage: { message: Tabs.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
})
export type Message = typeof Message.Type
