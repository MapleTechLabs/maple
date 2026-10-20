import { DashboardDocument, TimeRangeSchema } from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { DashboardSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Combobox from "../../../ui/combobox"
import * as Popover from "../../../ui/popover"
import * as CopyButton from "../../../ui/copy-button"
import * as Tabs from "../../../ui/tabs"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as TagEditor from "../kit/tag-editor"
import * as VariablesManager from "../kit/variables-manager/model"
import { HistoryState } from "./history"
import { SharingState } from "./share"
import { TableSort } from "../kit/tiles"
import { WidgetFailure, WidgetGate } from "../kit/widget-data"

// The dashboard view and builder.

export const Status = Schema.Literals(["Loading", "Ready", "Missing"])
export type Status = typeof Status.Type

/** One tile: lazily revealed (`useInViewportSticky`), measured, and what it asked for. */
export const WidgetSlot = Schema.Struct({
	isRevealed: Schema.Boolean,
	/** `useWidgetMaxDataPoints`' quantized width; `null` before the first measurement. */
	widthPx: Schema.NullOr(Schema.Number),
	gate: Schema.NullOr(WidgetGate),
	/** A stat's sparkline series (`StatSparklineLoader`), planned once the stat itself has data. */
	sparkGate: Schema.optionalKey(Schema.NullOr(WidgetGate)),
	/** `narrowedToCap`: the viewer pulled this list back to the list cap. */
	isNarrowed: Schema.optionalKey(Schema.Boolean),
})
export type WidgetSlot = typeof WidgetSlot.Type

/** The widget fetches, deduped by request key. */
export const RequestSlot = KeyedSchema(Schema.Unknown, WidgetFailure)
export type RequestSlot = typeof RequestSlot.Type

export const VariableOptionsSlot = KeyedSchema(Schema.Array(Schema.String), WidgetFailure)
export type VariableOptionsSlot = typeof VariableOptionsSlot.Type

/** `GridItem` (`@maple/grid-engine`): one placed tile in grid units. */
export const GridItem = Schema.Struct({
	i: Schema.String,
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	minW: Schema.optionalKey(Schema.Number),
	maxW: Schema.optionalKey(Schema.Number),
	minH: Schema.optionalKey(Schema.Number),
	maxH: Schema.optionalKey(Schema.Number),
})

export const PixelRect = Schema.Struct({
	left: Schema.Number,
	top: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
})

/** An in-progress pointer drag or resize over the grid (`useGridInteraction`'s pointer session). */
export const GridGesture = Schema.Struct({
	kind: Schema.Literals(["drag", "resize"]),
	widgetId: Schema.String,
	startX: Schema.Number,
	startY: Schema.Number,
	/** Pointer travel since the press. */
	dx: Schema.Number,
	dy: Schema.Number,
	/** Past the 3 px threshold: until then a press is still a click. */
	isStarted: Schema.Boolean,
	/** The grid's viewport position at the first frame; auto-scrolling moves it under the pointer. */
	gridOrigin: Schema.NullOr(Schema.Struct({ left: Schema.Number, top: Schema.Number })),
	/** The tile's box when it was picked up, inside the grid's padding box. */
	rect: PixelRect,
	origin: Schema.Array(GridItem),
	preview: Schema.Array(GridItem),
})
export type GridGesture = typeof GridGesture.Type

/** A tile picked up from its grip with Space (`useGridInteraction`'s keyboard session). */
export const KeyboardMove = Schema.Struct({
	widgetId: Schema.String,
	label: Schema.String,
	origin: Schema.Array(GridItem),
	preview: Schema.Array(GridItem),
})
export type KeyboardMove = typeof KeyboardMove.Type

export const SectionTargetSchema = Schema.Struct({ sectionId: Schema.String, tabId: Schema.String })

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
	tagEditor: TagEditor.Model,
	variablesManager: VariablesManager.Model,
	/** `historyPanelOpenAtom` / `previewedVersionAtom` and the panel's reads. */
	history: HistoryState,
	sharing: SharingState,
	/** `collectTags(dashboards)`: the tag editor's suggestions. */
	orgTags: Schema.Array(Schema.String),
	/** The picker's section tabs; the choice outlives a close, as the component state does. */
	pickerTabs: Tabs.Model,
	gesture: Schema.NullOr(GridGesture),
	keyboardMove: Schema.NullOr(KeyboardMove),
	/** The grid's polite live region: what the keyboard session just did. */
	gridAnnouncement: Schema.String,
	/** `settled`: a dropped layout, drawn until the store echoes the write back. */
	droppedLayout: Schema.NullOr(Schema.Array(GridItem)),
	/** Which container the dropped layout belongs to. */
	droppedKey: Schema.NullOr(Schema.String),
	persistenceError: Schema.NullOr(Schema.String),
	/** Failed tiles' "Details" popovers and their copy buttons, by widget id. */
	/** Which grid the picker's next widget lands in: a group's own "+", reset when it closes. */
	pickerTarget: Schema.NullOr(SectionTargetSchema),
	/** The one open group options menu. */
	sectionMenuId: Schema.NullOr(Schema.String),
	sectionMenu: Menu.Model,
	/** `InlineEditableText`: the group (or tab) title being renamed, and its draft. */
	rename: Schema.NullOr(
		Schema.Struct({ sectionId: Schema.String, tabId: Schema.NullOr(Schema.String), draft: Schema.String }),
	),
	/** `DeleteSectionDialog` and `DeleteTabDialog`, and what they would delete. */
	sectionDialog: Dialog.Model,
	pendingSectionDelete: Schema.NullOr(Schema.String),
	tabDialog: Dialog.Model,
	pendingTabDelete: Schema.NullOr(SectionTargetSchema),
	errorDetails: Schema.Record(Schema.String, Popover.Model),
	errorCopies: Schema.Record(Schema.String, CopyButton.Model),
	/** Each query variable's option list, by variable name (custom ones are inline). */
	variableOptions: Schema.Record(Schema.String, VariableOptionsSlot),
	/** The one open variable value list (`Combobox`), and which variable it is for. */
	variableCombo: Combobox.Model,
	variableComboName: Schema.NullOr(Schema.String),
	/** A textbox variable's text while typed, committed on blur or Enter. */
	variableDrafts: Schema.Record(Schema.String, Schema.String),
})
export type Model = typeof Model.Type
