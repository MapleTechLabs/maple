import {
	FUNNEL_POPULATION_FILTER_FIELDS,
	FunnelKeyBy,
	FunnelStep,
	FunnelVariant,
	PathsAnchor,
	PathsDirection,
} from "@maple/query-model"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as Select from "@maple/views/ui/select"
import { TimeWindow } from "../../data/time-range"
import { StepEdit, StepScope } from "../kit/funnel-steps"
import * as TimeRangePicker from "../kit/time-range-picker"
import { EventKindFilter } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** Every Keyed slot of the page, by its Model field. */
export const SlotName = Schema.Literals(["breakdowns", "events", "previousEvents", "funnel", "paths"])
export type SlotName = typeof SlotName.Type

/** A population filter: a `session_replays` dimension, one value each. */
export const FilterKey = Schema.Literals(FUNNEL_POPULATION_FILTER_FIELDS)
export type FilterKey = typeof FilterKey.Type

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, mode: RequestMode },
	/** Any slot's answer; `key` is what it was requested under, so a stale one is dropped. */
	CompletedFetch: {
		slot: SlotName,
		key: Schema.String,
		result: Schema.Result(Schema.Unknown, LoadFailure),
	},
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedRetry: { slot: SlotName },
	/** A rail option: `key` is any analytics filter; the page keeps its own (`FilterKey`). */
	ToggledFilter: { key: Schema.String, value: Schema.String },
	ChangedFilter: { key: Schema.String, value: Schema.UndefinedOr(Schema.String) },
	ClickedClearFilters: {},
	FailedFavicon: { host: Schema.String },
	ChangedEventsQuery: { value: Schema.String },
	PickedEventsKind: { kind: EventKindFilter },
	/** The empty list's Clear: the name filter and the kind both go. */
	ClickedClearEventsFilters: {},
	/** An Events row's Funnel: a new funnel starting at that event. */
	ClickedStartFunnel: { step: FunnelStep },
	/** An Events row's Paths, or a paths table's "Paths from here". */
	ClickedStartPaths: { anchor: PathsAnchor },
	ClickedSuggestedFunnel: { steps: Schema.Array(FunnelStep) },
	ChangedStep: { scope: StepScope, edit: StepEdit },
	GotStepComboMessage: { id: Schema.String, message: Combobox.Message },
	GotSelectMessage: { id: Schema.String, message: Select.Message },
	/** A typed step value held still long enough to run. */
	PausedTyping: { version: Schema.Number },
	PickedKeyBy: { keyBy: FunnelKeyBy },
	PickedWindow: { seconds: Schema.Number },
	PickedVariant: { variant: FunnelVariant },
	PickedDirection: { direction: PathsDirection },
	PickedDepth: { depth: Schema.Number },
	PickedBranches: { branches: Schema.Number },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type
