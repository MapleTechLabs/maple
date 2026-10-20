import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { AutocompleteLookup, LookupNames } from "../../page/kit/autocomplete-lookups"
import { QueryChange } from "../../page/kit/query-builder/change"
import { QueryDraft } from "../../page/kit/query-builder/draft"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import * as Combobox from "../../ui/combobox"
import * as Select from "../../ui/select"

// The query builder lab.

export const Session = Schema.Literals(["Checking", "SignedIn", "SignedOut", "Unreachable"])
export type Session = typeof Session.Type

export const RequestMode = Schema.Literals(["Load", "Refresh"])

/** `TimeRangeSearchFields`: the route's search, held locally (a lab has no router). */
export const TimeSearch = Schema.Struct({
	startTime: Schema.optionalKey(Schema.String),
	endTime: Schema.optionalKey(Schema.String),
	timePreset: Schema.optionalKey(Schema.String),
})
export type TimeSearch = typeof TimeSearch.Type

/** `QueryBuilderFormulaDraft`, in `createFormulaDraft`'s key order (the state preview prints it). */
export const FormulaDraft = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	expression: Schema.String,
	legend: Schema.String,
	hidden: Schema.Boolean,
})
export type FormulaDraft = typeof FormulaDraft.Type

/** `QueryBuilderTimeseriesInput` as the lab submits it. */
export const SubmittedInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	queries: Schema.Array(QueryDraft),
	formulas: Schema.Array(FormulaDraft),
})
export type SubmittedInput = typeof SubmittedInput.Type

/** `listMetrics` rows, reduced to what the metric select lists. */
export const MetricRow = Schema.Struct({ metricName: Schema.String, metricType: Schema.String })
export type MetricRow = typeof MetricRow.Type

/** `toRunPoints` and `debugWarnings` of a `getQueryBuilderTimeseries` response. */
export const RunPoint = Schema.Struct({
	bucket: Schema.String,
	series: Schema.Record(Schema.String, Schema.Number),
})
export type RunPoint = typeof RunPoint.Type

export const RunResult = Schema.Struct({
	points: Schema.Array(RunPoint),
	warnings: Schema.Array(Schema.String),
})
export type RunResult = typeof RunResult.Type

/** What the scroll area's viewport measured (Base UI's `ScrollArea` state). */
export const ScrollMetrics = Schema.Struct({ clientHeight: Schema.Number, scrollHeight: Schema.Number })
export type ScrollMetrics = typeof ScrollMetrics.Type

export const FormulaField = Schema.Literals(["expression", "legend"])
export type FormulaField = typeof FormulaField.Type

export const Model = Schema.Struct({
	session: Session,
	orgId: Schema.NullOr(OrgId),
	timeZone: Schema.String,
	search: TimeSearch,
	window: TimeWindow,
	picker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	queries: Schema.Array(QueryDraft),
	formulas: Schema.Array(FormulaDraft),
	lastRunAt: Schema.NullOr(Schema.String),
	submitted: Schema.NullOr(SubmittedInput),
	noQueriesError: Schema.NullOr(Schema.String),
	results: KeyedSchema(RunResult, LoadFailure),
	metrics: KeyedSchema(Schema.Array(MetricRow), LoadFailure),
	autocomplete: Schema.Record(Schema.String, KeyedSchema(LookupNames, LoadFailure)),
	selects: Schema.Record(Schema.String, Select.Model),
	groupBys: Schema.Record(Schema.String, Combobox.Model),
	scroll: Schema.NullOr(ScrollMetrics),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	SucceededCheckSession: { orgId: OrgId },
	FailedCheckSession: { session: Session },
	CompletedResolveWindow: { window: TimeWindow, mode: RequestMode },
	CompletedFetchAutocomplete: {
		key: Schema.String,
		lookup: AutocompleteLookup,
		result: Schema.Result(LookupNames, LoadFailure),
	},
	CompletedFetchMetrics: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(MetricRow), LoadFailure),
	},
	CompletedFetchTimeseries: { key: Schema.String, result: Schema.Result(RunResult, LoadFailure) },
	GotPickerMessage: { message: TimeRangePicker.Message },
	ClickedResetTimeRange: {},
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedAddQuery: {},
	CreatedQuery: { query: QueryDraft },
	ClickedAddFormula: {},
	CreatedFormula: { formula: FormulaDraft },
	ClickedCloneQuery: { queryId: Schema.String },
	CreatedCloneId: { queryId: Schema.String, id: Schema.String },
	ClickedRemoveQuery: { queryId: Schema.String },
	ClickedRemoveFormula: { formulaId: Schema.String },
	ClickedRun: {},
	StampedRun: { at: Schema.String },
	ToggledEnabled: { queryId: Schema.String },
	ChangedQuery: { queryId: Schema.String, change: QueryChange },
	GotSelectMessage: { id: Schema.String, message: Select.Message },
	GotGroupByMessage: { queryId: Schema.String, message: Combobox.Message },
	ChangedFormulaText: { formulaId: Schema.String, field: FormulaField, value: Schema.String },
	PressedWhereEnter: {},
	MeasuredScroll: { metrics: ScrollMetrics },
})
export type Message = typeof Message.Type

/** Read before init: the clock, the zone, the URL's window and the first drafts' random ids. */
export const Flags = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	search: TimeSearch,
	queries: Schema.Array(QueryDraft),
	formulas: Schema.Array(FormulaDraft),
})
export type Flags = typeof Flags.Type
