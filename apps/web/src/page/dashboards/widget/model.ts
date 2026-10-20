import { DashboardDocument, TimeRangeSchema } from "@maple/domain/http"
import { Schema } from "effect"
import { LookupNames } from "../../kit/autocomplete-lookups"
import { WhereFields } from "../../kit/where-field"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { DashboardWidgetSearch } from "../../../route/search"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import * as Tooltip from "../../../ui/tooltip"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { TableSort } from "../kit/tiles"
import { WidgetFailure, WidgetGate } from "../kit/widget-data"
import { EditorState } from "./editor-state"
import { RawSqlState } from "./raw-sql"
import { MetricPageSchema } from "./metric-option"
import { Suggestion } from "./suggestions"

// The widget editor.

export const Status = Schema.Literals(["Loading", "Ready", "Missing"])
export type Status = typeof Status.Type

export const SourceMode = Schema.Literals(["builder", "rawSql"])
export type SourceMode = typeof SourceMode.Type

export const Model = Schema.Struct({
	dashboardId: Schema.String,
	widgetId: Schema.String,
	search: DashboardWidgetSearch,
	status: Status,
	document: Schema.NullOr(DashboardDocument),
	/** `WidgetBuilderForm`: the editing state, seeded once from the stored widget. */
	state: Schema.NullOr(EditorState),
	/** `WidgetBuilderInitialSnapshot`: what `isDirty` compares against. */
	initial: Schema.NullOr(EditorState),
	/** `WidgetBuilderPreview`: the queries the preview runs, staged by Run preview. */
	staged: Schema.NullOr(EditorState),
	sourceMode: SourceMode,
	/** The source the widget was opened in: switching tabs is an unsaved change. */
	initialSourceMode: SourceMode,
	rawSql: Schema.NullOr(RawSqlState),
	/** `DashboardTimeRange`: the board's range, which the preview follows. */
	timeRange: Schema.NullOr(TimeRangeSchema),
	nowMs: Schema.NullOr(Schema.Number),
	/** The preview pane's quantized width (`useWidgetMaxDataPoints`); `null` until measured. */
	previewWidth: Schema.NullOr(Schema.Number),
	gate: Schema.NullOr(WidgetGate),
	/** A stat preview's trend series, planned once the stat has its value. */
	sparkGate: Schema.NullOr(WidgetGate),
	sparklineChart: Chart.Model,
	requests: Schema.Record(Schema.String, KeyedSchema(Schema.Unknown, WidgetFailure)),
	/** `DashboardVariablesProvider` at defaults: each query variable's option list, by name. */
	variableOptions: Schema.Record(Schema.String, KeyedSchema(Schema.Array(Schema.String), WidgetFailure)),
	chart: Chart.Model,
	tableSort: TableSort,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	timePicker: TimeRangePicker.Model,
	/** `WidgetTimeRange`'s picker under Custom: the widget's own window. */
	rangePicker: TimeRangePicker.Model,
	sourceTabs: Tabs.Model,
	/** The rail's selects, by id: unit and comparison. */
	selects: Schema.Record(Schema.String, Select.Model),
	/** The query panels' selects, group-by chips and collapsed set. */
	queryPanels: QueryPanel.Model,
	/** `AutocompleteValuesProvider lazy`: the lookups start once the query editor takes focus. */
	/** `listMetricsResultAtom`: the metric picker's page for `metricSearch`, once a query reads metrics. */
	metricSearch: Schema.String,
	metricOptions: Schema.NullOr(Schema.Struct({ search: Schema.String, ...MetricPageSchema.fields })),
	metricRequested: Schema.NullOr(Schema.String),
	/** `useMetricScopedAutocomplete`: each picked metric's attribute keys (`name::type`), the "by" choices. */
	metricKeys: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	metricKeysRequested: Schema.Array(Schema.String),
	isAutocompleteActive: Schema.Boolean,
	autocomplete: Schema.Record(Schema.String, KeyedSchema(LookupNames, LoadFailure)),
	/** `useFunnelSuggestions`: event names, page paths and facets, by lookup. */
	suggestions: Schema.Record(Schema.String, KeyedSchema(Schema.Array(Suggestion), LoadFailure)),
	/** The step inputs' comboboxes, by id. */
	stepCombos: Schema.Record(Schema.String, Combobox.Model),
	/** The list, population and step filters' carets, lists and key values. */
	whereFields: WhereFields,
	/** The list column whose field input shows its suggestions. */
	listFieldFocus: Schema.NullOr(Schema.Number),
	/** The funnel or paths panel's own collapse toggle (`QueryPanelShell`'s state). */
	isProductPanelCollapsed: Schema.Boolean,
	breakdownAttribute: Schema.Struct({ isActive: Schema.Boolean, key: Schema.String }),
	/** The Raw SQL chips' description tooltip (one model, a trigger per chip). */
	sqlChipTooltip: Tooltip.Model,
	isSaving: Schema.Boolean,
	/** The unsaved-changes confirmation (`useBlocker`). */
	leaveDialog: Dialog.Model,
	/** Where the held navigation was going: Discard goes there (Cancel's is the dashboard). */
	pendingLeaveUrl: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type
