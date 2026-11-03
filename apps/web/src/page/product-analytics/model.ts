import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as Select from "@maple/views/ui/select"
import { TimeWindow } from "../../data/time-range"
import { ProductAnalyticsSearch } from "../../route/search"
import { Breakdowns } from "../kit/analytics-filter-rail"
import { StepDraft } from "../kit/funnel-steps"
import * as TimeRangePicker from "../kit/time-range-picker"

// `/product-analytics`: product events by name, funnels over them, and the paths around one.

/** `ProductEventName`: one event name in the window, how often and by how many. */
export const EventRow = Schema.Struct({
	eventName: Schema.String,
	/** `navigation` for page views, `custom` for `track()` calls, `screen` for mobile screens. */
	kind: Schema.String,
	count: Schema.Number,
	sessions: Schema.Number,
	persons: Schema.Number,
})
export type EventRow = typeof EventRow.Type

/** `track()` calls and server events; page views (`navigation`) and mobile screens are the others. */
export const isCustomEvent = (row: EventRow): boolean => row.kind !== "navigation" && row.kind !== "screen"

/** `FunnelWidgetRow`: one step's bar, with the drop-off view's timing and leavers. */
export const FunnelRow = Schema.Struct({
	name: Schema.String,
	value: Schema.Number,
	p50Ms: Schema.optionalKey(Schema.Number),
	p90Ms: Schema.optionalKey(Schema.Number),
	leavers: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number }))),
})
export type FunnelRow = typeof FunnelRow.Type

/** `PathsWidgetRow`: one hop between two nodes. */
export const PathsRow = Schema.Struct({
	hop: Schema.Number,
	fromNode: Schema.String,
	toNode: Schema.String,
	count: Schema.Number,
})
export type PathsRow = typeof PathsRow.Type

export const EventKindFilter = Schema.Literals(["all", "custom", "navigation", "screen"])
export type EventKindFilter = typeof EventKindFilter.Type

export const Model = Schema.Struct({
	search: ProductAnalyticsSearch,
	window: Schema.NullOr(TimeWindow),
	breakdowns: KeyedSchema(Breakdowns, LoadFailure),
	events: KeyedSchema(Schema.Array(EventRow), LoadFailure),
	previousEvents: KeyedSchema(Schema.Array(EventRow), LoadFailure),
	funnel: KeyedSchema(Schema.Array(FunnelRow), LoadFailure),
	paths: KeyedSchema(Schema.Array(PathsRow), LoadFailure),
	/** The funnel steps as edited; the URL catches up on a pick, or once typing pauses. */
	steps: Schema.Array(StepDraft),
	anchor: StepDraft,
	/** The steps and anchor this page last wrote to the URL, so its own navigation keeps the draft. */
	committed: Schema.String,
	/** Bumped by each typed edit; only the last one's pause commits. */
	typingVersion: Schema.Number,
	stepCombos: Schema.Record(Schema.String, Combobox.Model),
	selects: Schema.Record(Schema.String, Select.Model),
	eventsQuery: Schema.String,
	eventsKind: EventKindFilter,
	failedFavicons: Schema.Array(Schema.String),
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
