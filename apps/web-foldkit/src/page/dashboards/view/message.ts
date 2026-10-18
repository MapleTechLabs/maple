import { DashboardDocument, DashboardWidgetSchema } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { WidgetFailure } from "../kit/widget-data"

/** A write's outcome: the failure is the message the persistence banner shows. */
const WriteResult = Schema.Result(Schema.Void, Schema.String)

export const Message = defineMessageUnion({
	UpdatedDashboard: { orgId: Schema.String, maybeDocument: Schema.Option(DashboardDocument) },
	CompletedReadClock: { nowMs: Schema.Number },
	MeasuredGrid: { width: Schema.Number },
	MeasuredWidget: { widgetId: Schema.String, widthPx: Schema.Number },
	RevealedWidget: { widgetId: Schema.String },
	CompletedFetchWidget: { key: Schema.String, result: Schema.Result(Schema.Unknown, WidgetFailure) },
	CompletedFetchShares: { dashboardId: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { widgetId: Schema.String, message: Chart.Message },
	ClickedSortColumn: { widgetId: Schema.String, field: Schema.String, isText: Schema.Boolean },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotRefreshMenuMessage: { message: Menu.Message },
	ClickedReload: {},
	/** `useIntervalRefresh`: one auto-refresh tick, fanned out to every tile like a Reload. */
	TickedAutoRefresh: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedToggleEdit: {},
	GotMoreMenuMessage: { message: Menu.Message },
	GotWidgetMenuMessage: { widgetId: Schema.String, message: Menu.Message },
	ClickedTitle: {},
	ChangedTitleDraft: { value: Schema.String },
	SubmittedTitle: {},
	CancelledTitle: {},
	ClickedAddWidget: {},
	GotPickerDialogMessage: { message: Dialog.Message },
	ClickedWidgetPreset: { presetId: Schema.String },
	PressedGrip: { widgetId: Schema.String, clientX: Schema.Number, clientY: Schema.Number },
	PressedResizeHandle: { widgetId: Schema.String, clientX: Schema.Number, clientY: Schema.Number },
	MovedPointer: { clientX: Schema.Number, clientY: Schema.Number },
	ReleasedPointer: {},
	CompletedWrite: { result: WriteResult },
	/** "Undo" on the "Widget removed" toast: the removed tile, as it was stored. */
	ClickedUndoRemoveWidget: { widget: DashboardWidgetSchema },
	CompletedExport: {},
})
export type Message = typeof Message.Type
