import { DashboardDocument, HEATMAP_SCALE_TYPES } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import * as Tooltip from "../../../ui/tooltip"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { LoadFailure } from "../../../data/load-failure"
import { AutocompleteLookup, LookupNames } from "../../kit/autocomplete-lookups"
import { WhereFieldMessage } from "../../kit/where-field"
import { WidgetFailure } from "../kit/widget-data"
import { LegendPosition, PointsMode } from "./editor-state"
import { MetricPageSchema } from "./metric-option"
import { ProductEdit } from "./product-edit"
import { Suggestion, SuggestionLookup } from "./suggestions"

export const FormulaTextField = Schema.Literals(["expression", "legend"])
export type FormulaTextField = typeof FormulaTextField.Type

/** `applyList`: the list's lowered query takes a fresh id on Apply (`createQueryDraft(0)`). */
export const GeneratedIdPurpose = Schema.Literals(["addQuery", "cloneQuery", "addFormula", "applyList"])
export type GeneratedIdPurpose = typeof GeneratedIdPurpose.Type

export const Message = defineMessageUnion({
	UpdatedDashboard: { orgId: Schema.String, maybeDocument: Schema.Option(DashboardDocument) },
	CompletedReadClock: { nowMs: Schema.Number },
	MeasuredPreview: { widthPx: Schema.Number },
	CompletedFetchWidget: { key: Schema.String, result: Schema.Result(Schema.Unknown, WidgetFailure) },
	CompletedFetchVariableOptions: {
		name: Schema.String,
		key: Schema.String,
		result: Schema.Result(Schema.Array(Schema.String), WidgetFailure),
	},
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { message: Chart.Message },
	GotSparklineChartMessage: { message: Chart.Message },
	ClickedSortColumn: { field: Schema.String, isText: Schema.Boolean },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotRangePickerMessage: { message: TimeRangePicker.Message },
	CompletedSaveTimeRange: { error: Schema.NullOr(Schema.String) },
	GotSourceTabsMessage: { message: Tabs.Message },
	GotSelectMessage: { id: Schema.String, message: Select.Message },
	GotQueryPanelMessage: { message: QueryPanel.Message },
	ClickedAddQuery: {},
	ClickedAddFormula: {},
	/** A fresh id for what was asked (`crypto.randomUUID()`). */
	GeneratedId: {
		purpose: GeneratedIdPurpose,
		source: Schema.String,
		id: Schema.String,
	},
	ToggledFormulaVisible: { formulaId: Schema.String },
	ChangedFormulaText: { formulaId: Schema.String, field: FormulaTextField, value: Schema.String },
	ClickedRemoveFormula: { formulaId: Schema.String },
	ClickedRunPreview: {},
	ChangedSql: { value: Schema.String },
	ChangedSqlBucket: { value: Schema.String },
	ClickedSqlToken: { token: Schema.String },
	CompletedInsertSqlToken: { sql: Schema.String, caret: Schema.Number },
	CompletedFocusSql: {},
	ToggledSqlCollapsed: {},
	GotSqlChipTooltipMessage: { message: Tooltip.Message },
	ChangedTitle: { value: Schema.String },
	ChangedMarkdown: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	ChangedTimeRangeMode: { mode: Schema.Literals(["dashboard", "custom"]) },
	ClickedPanelType: { panel: Schema.String },
	ChangedStacked: { isStacked: Schema.Boolean },
	ChangedCurve: { curveType: Schema.Literals(["linear", "monotone"]) },
	ChangedPoints: { pointsMode: PointsMode },
	ChangedLegend: { legendPosition: LegendPosition },
	ToggledSeriesStats: {},
	ClickedAddThreshold: {},
	ChangedThresholdValue: { index: Schema.Number, value: Schema.String },
	ChangedThresholdColor: { index: Schema.Number, color: Schema.String },
	ClickedRemoveThreshold: { index: Schema.Number },
	ToggledPercentChange: {},
	ChangedUnit: { unit: Schema.String },
	ToggledSparkline: {},
	ChangedGaugeBound: { bound: Schema.Literals(["min", "max"]), value: Schema.String },
	ChangedTableLimit: { value: Schema.String },
	ChangedHeatmapScaleType: { scaleType: Schema.Literals(HEATMAP_SCALE_TYPES) },
	ClickedApply: {},
	CompletedSave: { error: Schema.NullOr(Schema.String) },
	ClickedCancel: {},
	GotLeaveDialogMessage: { message: Dialog.Message },
	ClickedDiscard: {},
	FocusedQueryEditor: {},
	/** An edit of the list, funnel or paths panel. */
	ChangedProduct: { edit: ProductEdit },
	/** A step's suggesting input (`SuggestingInput`), by combobox id. */
	GotStepComboMessage: { id: Schema.String, message: Combobox.Message },
	FocusedListField: { index: Schema.Number },
	/** The list, population and step filters' suggestions (`WhereFields`). */
	GotWhereFieldMessage: { message: WhereFieldMessage },
	ToggledProductPanel: {},
	BlurredListField: {},
	/** The key typed under `BreakdownPicker`'s "Attribute..." mode. */
	ChangedBreakdownAttribute: { value: Schema.String },
	CompletedFetchSuggestions: {
		key: Schema.String,
		lookup: SuggestionLookup,
		result: Schema.Result(Schema.Array(Suggestion), LoadFailure),
	},
	CompletedFetchMetricOptions: {
		search: Schema.String,
		result: Schema.Result(MetricPageSchema, LoadFailure),
	},
	CompletedFetchMetricKeys: {
		metric: Schema.String,
		result: Schema.Result(Schema.Array(Schema.String), LoadFailure),
	},
	CompletedFetchAutocomplete: {
		key: Schema.String,
		lookup: AutocompleteLookup,
		result: Schema.Result(LookupNames, LoadFailure),
	},
})
export type Message = typeof Message.Type
