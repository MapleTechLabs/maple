import { DashboardDocument, TimeRangeSchema } from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { DashboardWidgetSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { TableSort } from "../kit/tiles"
import { WidgetFailure, WidgetGate } from "../kit/widget-data"
import { EditorState } from "./editor-state"

// The widget editor (apps/web/src/routes/dashboards/$dashboardId_.widgets.$widgetId.tsx and
// dashboard-builder/config/widget-query-builder-page.tsx).

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
	chart: Chart.Model,
	tableSort: TableSort,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	timePicker: TimeRangePicker.Model,
	sourceTabs: Tabs.Model,
	/** The rail's selects, by id: unit and comparison. */
	selects: Schema.Record(Schema.String, Select.Model),
	/** The query panels' selects, group-by chips and collapsed set. */
	queryPanels: QueryPanel.Model,
	/** `AutocompleteValuesProvider lazy`: the lookups start once the query editor takes focus. */
	isAutocompleteActive: Schema.Boolean,
	autocomplete: Schema.Record(Schema.String, KeyedSchema(Schema.Array(Schema.String), LoadFailure)),
	isSaving: Schema.Boolean,
	/** The unsaved-changes confirmation (`useBlocker`). */
	leaveDialog: Dialog.Model,
})
export type Model = typeof Model.Type
