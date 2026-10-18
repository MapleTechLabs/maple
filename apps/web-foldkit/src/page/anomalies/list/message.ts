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
	CompletedLoadMore: { status: StatusTab, result: Schema.Result(IncidentPage, LoadFailure) },
	ClickedRetry: {},
	TickedLiveRefresh: {},
	ToggledLive: {},
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	RemovedFilterChip: { param: FilterParam },
	ClickedClearFilters: {},
	ClickedClearExclusions: {},
	ToggledGroup: { group: GroupKey },
	HoveredRow: { id: Schema.String },
	PaintedBody: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	GotTabsMessage: { message: Tabs.Message },
	GotFilterSectionsMessage: { message: FilterSections.Message },
})
export type Message = typeof Message.Type
