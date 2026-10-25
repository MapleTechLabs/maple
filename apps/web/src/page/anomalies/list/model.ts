import { V2AnomalyIncident } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { AnomaliesSearch } from "../../../route/search"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as Tabs from "../../../ui/tabs"
import { SignalPresenceData } from "../../kit/signal-presence"

// `/anomalies`.

export const StatusTab = Schema.Literals(["open", "resolved", "all"])
export type StatusTab = typeof StatusTab.Type

export const GroupKey = Schema.Literals(["critical", "warning", "resolved"])
export type GroupKey = typeof GroupKey.Type

/** One page of `anomalies.listIncidents`. */
export const IncidentPage = Schema.Struct({
	data: Schema.Array(V2AnomalyIncident),
	nextCursor: Schema.NullOr(Schema.String),
})
export type IncidentPage = typeof IncidentPage.Type

/** `LoadedPages`: pages past the first, for the tab they were fetched for. */
export const LoadedPages = Schema.Struct({
	key: StatusTab,
	rows: Schema.Array(V2AnomalyIncident),
	nextCursor: Schema.NullOr(Schema.String),
})
export type LoadedPages = typeof LoadedPages.Type

export const Model = Schema.Struct({
	search: AnomaliesSearch,
	/** `Date.now()` at render: relative times and the stale-incident cut. */
	nowMs: Schema.Number,
	firstPage: KeyedSchema(IncidentPage, LoadFailure),
	loadedPages: Schema.NullOr(LoadedPages),
	isLoadingMore: Schema.Boolean,
	presence: SignalPresenceData.schema,
	tabs: Tabs.Model,
	filterSections: FilterSections.Model,
	/** `AnomalyGroup`'s `isOpen`, per group: the collapsed ones. */
	collapsedGroups: Schema.Array(GroupKey),
	focusedId: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type
