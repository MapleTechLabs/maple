import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import { LookupNames } from "../../kit/autocomplete-lookups"
import * as AddToDashboard from "./add-to-dashboard"
import { WhereEditor } from "./where-editor"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { MetricSearch } from "../../../route/search"
import * as Combobox from "@maple/views/ui/combobox"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Select from "@maple/views/ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { MetricRow } from "../shared"

export const AttributeKeyRow = Schema.Struct({ attributeKey: Schema.String, usageCount: Schema.Number })
export type AttributeKeyRow = typeof AttributeKeyRow.Type

export const TimeseriesRows = Schema.Array(
	Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
)
export type TimeseriesRows = typeof TimeseriesRows.Type

export const BreakdownRow = Schema.Struct({ name: Schema.String, value: Schema.Number })
export type BreakdownRow = typeof BreakdownRow.Type

/** The autocomplete value lookups, read by the where-clause editor. */
export { AutocompleteLookup } from "../../kit/autocomplete-lookups"

export const Model = Schema.Struct({
	metricName: Schema.String,
	search: MetricSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The catalog rows matching the metric name (limit 1000). */
	catalog: KeyedSchema(Schema.Array(MetricRow), LoadFailure),
	/** Each provider lookup's slot; the values are the names the editor suggests. */
	autocomplete: Schema.Record(Schema.String, KeyedSchema(LookupNames, LoadFailure)),
	/** The attribute keys scoped to the metric (controls, breakdown, metadata). */
	attributeKeys: KeyedSchema(Schema.Array(AttributeKeyRow), LoadFailure),
	timeseries: KeyedSchema(TimeseriesRows, LoadFailure),
	breakdown: KeyedSchema(Schema.Array(BreakdownRow), LoadFailure),
	/** The where clause as typed; committed to the URL 400 ms after the last keystroke. */
	whereInput: Schema.String,
	whereGeneration: Schema.Number,
	/** The where editor's caret, focus and suggestion list. */
	whereEditor: WhereEditor,
	/** The step interval as typed; committed on blur or Enter. */
	stepInput: Schema.String,
	aggregationSelect: Select.Model,
	groupByCombobox: Combobox.Model,
	breakdownCombobox: Combobox.Model,
	copyLink: CopyButton.Model,
	addToDashboard: AddToDashboard.Model,
	chart: Chart.Model,
	timePicker: TimeRangePicker.Model,
	...ChartEnvFields,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
