import { DashboardDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Combobox from "../../../ui/combobox"
import * as Popover from "../../../ui/popover"
import * as CopyButton from "../../../ui/copy-button"
import * as Tabs from "../../../ui/tabs"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as TagEditor from "../kit/tag-editor"
import * as VariablesManager from "../kit/variables-manager/model"
import { WidgetFailure } from "../kit/widget-data"
import { WriteSync } from "../kit/store"
import { LoadFailure } from "../../../data/load-failure"
import { VersionRow } from "./history"
import { ShareMessage } from "./share"

/** A write's outcome: the failure is the message the persistence banner shows. */
const WriteResult = Schema.Result(WriteSync, Schema.String)

export const Message = defineMessageUnion({
	UpdatedDashboard: { orgId: Schema.String, maybeDocument: Schema.Option(DashboardDocument) },
	CompletedReadClock: { nowMs: Schema.Number },
	MeasuredGrid: { width: Schema.Number },
	MeasuredWidget: { widgetId: Schema.String, widthPx: Schema.Number },
	RevealedWidget: { widgetId: Schema.String },
	ClickedNarrowRange: { widgetId: Schema.String },
	CompletedFetchWidget: { key: Schema.String, result: Schema.Result(Schema.Unknown, WidgetFailure) },
	CompletedFetchVariableOptions: {
		name: Schema.String,
		key: Schema.String,
		result: Schema.Result(Schema.Array(Schema.String), WidgetFailure),
	},
	GotShareMessage: { message: ShareMessage },
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
	ClickedChartStyle: { chartId: Schema.String },
	GotTagEditorMessage: { message: TagEditor.Message },
	GotVariablesManagerMessage: { message: VariablesManager.Message },
	ClickedCloseHistory: {},
	CompletedFetchVersions: { generation: Schema.Number, result: Schema.Result(Schema.Array(VersionRow), LoadFailure) },
	ClickedVersion: { versionId: Schema.String },
	CompletedFetchSnapshot: { versionId: Schema.String, result: Schema.Result(DashboardDocument, LoadFailure) },
	ClickedCancelPreview: {},
	ClickedRestoreVersion: {},
	GotRestoreDialogMessage: { message: Dialog.Message },
	ConfirmedRestore: {},
	CompletedRestore: { versionNumber: Schema.Number, error: Schema.NullOr(Schema.String) },
	UpdatedOrgTags: { tags: Schema.Array(Schema.String) },
	GotPickerTabsMessage: { message: Tabs.Message },
	PressedGrip: { widgetId: Schema.String, clientX: Schema.Number, clientY: Schema.Number },
	PressedResizeHandle: { widgetId: Schema.String, clientX: Schema.Number, clientY: Schema.Number },
	/** One animation frame of a gesture: the pointer, and where the grid now sits (it scrolls). */
	MovedPointer: {
		clientX: Schema.Number,
		clientY: Schema.Number,
		gridLeft: Schema.Number,
		gridTop: Schema.Number,
	},
	ReleasedPointer: {},
	/** `pointercancel` or Escape: the gesture ends where it began. */
	CancelledPointer: {},
	/** A key on a grip (`DashboardGrid`'s keydown): Space or Enter picks up and drops, arrows move. */
	PressedGripKey: {
		widgetId: Schema.String,
		label: Schema.String,
		key: Schema.String,
		isShift: Schema.Boolean,
	},
	/** Focus left a picked-up tile's grip for somewhere outside it: the tile drops where it is. */
	BlurredGrip: { widgetId: Schema.String },
	CompletedWrite: { result: WriteResult },
	/** "Undo" on the "Widget removed" toast: the removed tile, as it was stored. */
	/** "Undo" after a group was deleted with its widgets: they come back on the board, the group does not. */
	CompletedExport: {},
	/** A group's chevron: this viewer's collapse, in the URL. */
	ClickedSectionChevron: { sectionId: Schema.String, collapsed: Schema.Boolean },
	ClickedSectionTab: { sectionId: Schema.String, tabId: Schema.String },
	/** A group's "+" or its empty state's "Add widget": the picker, targeting that tab. */
	ClickedAddSectionWidget: { sectionId: Schema.String, tabId: Schema.String },
	GotSectionMenuMessage: { sectionId: Schema.String, message: Menu.Message },
	/** Double-click, Enter or F2 on a group or tab title. */
	StartedRename: { sectionId: Schema.String, tabId: Schema.NullOr(Schema.String) },
	ChangedRenameDraft: { value: Schema.String },
	SubmittedRename: {},
	CancelledRename: {},
	ClickedAddTab: { sectionId: Schema.String },
	ClickedDeleteTab: { sectionId: Schema.String, tabId: Schema.String },
	GotSectionDialogMessage: { message: Dialog.Message },
	GotTabDialogMessage: { message: Dialog.Message },
	ConfirmedDeleteSection: { action: Schema.Literals(["ungroup", "delete"]) },
	ConfirmedDeleteTab: { action: Schema.Literals(["move", "delete"]) },
	GotVariableComboMessage: { name: Schema.String, message: Combobox.Message },
	ChangedVariableDraft: { name: Schema.String, value: Schema.String },
	CommittedVariableDraft: { name: Schema.String },
	ClickedManageVariables: {},
	GotErrorDetailsMessage: { widgetId: Schema.String, message: Popover.Message },
	GotErrorCopyMessage: { widgetId: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
