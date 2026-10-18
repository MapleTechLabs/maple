import { DashboardDocument, TimeRangeSchema } from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { DashboardSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { TableSort } from "../kit/tiles"
import { WidgetFailure, WidgetGate } from "../kit/widget-data"

// The dashboard view and builder (apps/web/src/routes/dashboards/$dashboardId.tsx).

export const Status = Schema.Literals(["Loading", "Ready", "Missing"])
export type Status = typeof Status.Type

/** One tile: lazily revealed (`useInViewportSticky`), measured, and what it asked for. */
export const WidgetSlot = Schema.Struct({
	isRevealed: Schema.Boolean,
	/** `useWidgetMaxDataPoints`' quantized width; `null` before the first measurement. */
	widthPx: Schema.NullOr(Schema.Number),
	gate: Schema.NullOr(WidgetGate),
})
export type WidgetSlot = typeof WidgetSlot.Type

/** The widget fetches, deduped by request key like apps/web's atom family. */
export const RequestSlot = KeyedSchema(Schema.Unknown, WidgetFailure)
export type RequestSlot = typeof RequestSlot.Type

/** An in-progress pointer drag or resize over the grid (`useGridInteraction`). */
export const GridGesture = Schema.Struct({
	kind: Schema.Literals(["drag", "resize"]),
	widgetId: Schema.String,
	startX: Schema.Number,
	startY: Schema.Number,
	/** The cell under the pointer, in grid units, as the gesture last resolved it. */
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
})
export type GridGesture = typeof GridGesture.Type

export const Model = Schema.Struct({
	dashboardId: Schema.String,
	search: DashboardSearch,
	status: Status,
	document: Schema.NullOr(DashboardDocument),
	/** `DashboardTimeRange`: seeded from the document once, then the picker's. */
	timeRange: Schema.NullOr(TimeRangeSchema),
	nowMs: Schema.NullOr(Schema.Number),
	/** `PageRefreshProvider.refreshVersion`: 0 snaps the window to the cache grid. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** `useContainerWidth` of the sections container; 0 until measured. */
	gridWidth: Schema.Number,
	widgets: Schema.Record(Schema.String, WidgetSlot),
	requests: Schema.Record(Schema.String, RequestSlot),
	charts: Schema.Record(Schema.String, Chart.Model),
	tableSorts: Schema.Record(Schema.String, TableSort),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	/** `dashboardSharesAtom`: once loaded, every widget menu gains "Embed chart". */
	shares: Schema.Literals(["Idle", "Loading", "Loaded"]),
	timePicker: TimeRangePicker.Model,
	refreshMenu: Menu.Model,
	moreMenu: Menu.Model,
	widgetMenuId: Schema.NullOr(Schema.String),
	widgetMenu: Menu.Model,
	/** `InlineEditableTitle`. */
	titleDraft: Schema.NullOr(Schema.String),
	pickerDialog: Dialog.Model,
	gesture: Schema.NullOr(GridGesture),
	persistenceError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type
