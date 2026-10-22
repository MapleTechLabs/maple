import {
	pickDashboardControlParams,
	variableValuesFromSearch,
} from "../../../lib/dashboard-controls/search-params"
import { behindToast } from "../kit/store"
import { DashboardRefreshIntervalSeconds } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { AppRoute, hrefOf } from "../../../route"
import type { DashboardSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Combobox from "../../../ui/combobox"
import * as Popover from "../../../ui/popover"
import * as CopyButton from "../../../ui/copy-button"
import * as Tabs from "../../../ui/tabs"
import { popupId } from "../../../ui/overlay/popup-state"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CloneWidget,
	EditSections,
	CompleteReloadSpin,
	ExportDashboard,
	FetchShares,
	ReadClock,
	RemoveWidget,
	RenameDashboard,
	AddWidget,
	AutoLayout,
	SaveTags,
	SaveRefreshInterval,
	SaveTimeRange,
} from "./command"
import { gestureStep } from "./gesture"
import { Message } from "./message"
import type { Model } from "./model"
import { replan, slotOf, withCharts } from "./plan"
import { isEditing } from "./mode"
import { PICKER_TABS } from "./picker-catalog"
import { menuStep } from "./menu-step"
import { sectionStep } from "./section-update"
import { variableStep } from "./variable-update"
import { historyStep, openHistory } from "./history-update"
import { openEmbed, openShare, shareStep } from "./share-update"
import { initHistory } from "./history"
import { initSharing } from "./share"
import * as VariablesManagerUpdate from "../kit/variables-manager/update"
import { managerStep, openVariablesManager } from "./variables-manager"
import { SectionEdit } from "./section-edit"
import { moveTargetOf } from "./move-target"
import * as TagEditor from "../kit/tag-editor"
import { createAlertSearch } from "./widget-actions"

export type Return = PageReturn<Model, Message>
type Search = typeof DashboardSearch.Type
type Route = Readonly<{ dashboardId: string; search: Search }>

export const init = (route: Route, _context: PageContext): Return => ({
	model: {
		dashboardId: route.dashboardId,
		search: route.search,
		status: "Loading",
		document: null,
		timeRange: null,
		nowMs: null,
		refreshVersion: 0,
		isReloading: false,
		gridWidth: 0,
		widgets: {},
		requests: {},
		charts: {},
		tableSorts: {},
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		shares: "Idle",
		timePicker: TimeRangePicker.init("dashboard-time-range"),
		refreshMenu: Menu.init("dashboard-refresh-menu"),
		moreMenu: Menu.init("dashboard-more-menu"),
		widgetMenuId: null,
		widgetMenu: Menu.init("dashboard-widget-menu"),
		titleDraft: null,
		pickerDialog: Dialog.init("dashboard-widget-picker", "dialog"),
		tagEditor: TagEditor.init("dashboard-view-tags-dialog"),
		variablesManager: VariablesManagerUpdate.init("dashboard-variables-dialog"),
		history: initHistory(),
		sharing: initSharing(),
		orgTags: [],
		pickerTabs: Tabs.init({ idBase: 300, values: PICKER_TABS.map((tab) => tab.id), selected: "all" }),
		gesture: null,
		keyboardMove: null,
		gridAnnouncement: "",
		droppedLayout: null,
		droppedKey: null,
		persistenceError: null,
		pickerTarget: null,
		sectionMenuId: null,
		sectionMenu: Menu.init("dashboard-section-menu"),
		rename: null,
		sectionDialog: Dialog.init("dashboard-delete-section", "alert-dialog"),
		pendingSectionDelete: null,
		tabDialog: Dialog.init("dashboard-delete-tab", "alert-dialog"),
		pendingTabDelete: null,
		errorDetails: {},
		errorCopies: {},
		variableOptions: {},
		variableCombo: Combobox.init("dashboard-variable", "single"),
		variableComboName: null,
		variableDrafts: {},
	},
	commands: [
		ReadClock(),
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

const sameValues = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
	Object.keys(a).length === Object.keys(b).length &&
	Object.entries(a).every(([key, value]) => b[key] === value)

/** A `var-*` change re-plans the tiles that read the variable (their request keys move). */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	const next = { ...model, search: route.search }
	return sameValues(variableValuesFromSearch(model.search), variableValuesFromSearch(route.search))
		? { model: next }
		: withReplan(next, context, "Load")
}

export { isEditing } from "./mode"

const dashboardHref = (model: Model, search: Search) =>
	hrefOf(
		AppRoute.Dashboard({
			dashboardId: AppRoute.Dashboard.fields.dashboardId.make(model.dashboardId),
			search,
		}),
	)

const navigate = (model: Model, url: string, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace }),
})

/** `handleToggleEdit`: the per-viewer controls survive; only `mode` flips. */
const toggleEdit = (model: Model): Return => {
	const controls = pickDashboardControlParams(model.search)
	return navigate(model, dashboardHref(model, isEditing(model) ? controls : { ...controls, mode: "edit" }))
}

/** `PageRefreshProvider.reload`: a new clock, an unsnapped window and the Reload spinner. */
const reload = (model: Model): Return => {
	const refreshVersion = model.refreshVersion + 1
	return {
		model: { ...model, refreshVersion, isReloading: true },
		commands: [ReadClock(), CompleteReloadSpin({ version: refreshVersion })],
	}
}

/** `open={readOnly ? false : chartPickerOpen}`: the picker closes once writes are unavailable. */
const closePicker = (model: Model): Return => {
	if (!model.pickerDialog.isOpen) return { model }
	const closed = Dialog.close(model.pickerDialog)
	return {
		model: { ...model, pickerDialog: closed.model, pickerTarget: null },
		commands: Command.mapMessages(closed.commands ?? [], (dialog) =>
			Message.GotPickerDialogMessage({ message: dialog }),
		),
	}
}

/**
 * The picker's `onSelect` (`addWidget`): the dialog closes on the add, and an add from view mode
 * carries the board into edit mode with the viewer's controls.
 */
const addPicked = (
	model: Model,
	context: PageContext,
	pick: { readonly presetId: string | null; readonly chartId: string | null },
): Return => {
	if (model.persistenceError !== null) {
		const shut = closePicker(model)
		return {
			...shut,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Dashboard editing is unavailable right now",
				description: "Reconnect to the dashboard store, then add the widget again.",
				timeoutMs: null,
				action: null,
			}),
		}
	}
	const closed = Dialog.close(model.pickerDialog)
	const commands = [
		...Command.mapMessages(closed.commands ?? [], (dialog) =>
			Message.GotPickerDialogMessage({ message: dialog }),
		),
		AddWidget({
			orgId: context.orgId,
			dashboardId: model.dashboardId,
			...pick,
			target: model.pickerTarget,
		}),
	]
	const updated = { ...model, pickerDialog: closed.model, pickerTarget: null }
	return isEditing(model)
		? { model: updated, commands }
		: {
				model: updated,
				commands,
				outMessage: PageOutMessage.RequestedNavigation({
					url: dashboardHref(model, { ...pickDashboardControlParams(model.search), mode: "edit" }),
					isReplace: false,
				}),
			}
}

const wrapTagEditor = (message: TagEditor.Message) => Message.GotTagEditorMessage({ message })

const decodeInterval = (value: string) =>
	Schema.decodeUnknownOption(DashboardRefreshIntervalSeconds)(Number(value))

/**
 * `handleRefreshIntervalChange`: the cadence rides in `?refresh=` for this viewer, and in edit
 * mode it is also saved as the board's default.
 */
const pickRefreshInterval = (
	model: Model,
	context: PageContext,
	refreshIntervalSeconds: DashboardRefreshIntervalSeconds,
): Return => {
	const controls = pickDashboardControlParams(model.search)
	// `mode` stays as the URL had it; only a writable edit session saves the default.
	const search =
		model.search.mode === "edit"
			? { ...controls, mode: "edit" as const, refresh: refreshIntervalSeconds }
			: { ...controls, refresh: refreshIntervalSeconds }
	return {
		model,
		commands: isEditing(model)
			? [
					SaveRefreshInterval({
						orgId: context.orgId,
						dashboardId: model.dashboardId,
						refreshIntervalSeconds,
					}),
				]
			: [],
		outMessage: PageOutMessage.RequestedNavigation({
			url: dashboardHref(model, search),
			isReplace: true,
		}),
	}
}

/** A step that may change which document the canvas shows, then the plan for that document. */
const replanAfter = (stepped: Return, context: PageContext): Return => {
	const planned = replan(stepped.model, context, "Load")
	return { ...stepped, model: planned.model, commands: [...(stepped.commands ?? []), ...planned.commands] }
}

const withReplan = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const planned = replan(model, context, mode)
	return { model: planned.model, commands: planned.commands }
}

/** The live document arrived (or changed): seed the range once, then plan the revealed tiles. */
const receiveDocument = (
	model: Model,
	context: PageContext,
	message: Message & { _tag: "UpdatedDashboard" },
): Return =>
	Option.match(message.maybeDocument, {
		onNone: () => ({ model: { ...model, status: "Missing", document: null } }),
		onSome: (document) => {
			const next: Model = {
				...model,
				status: "Ready",
				document,
				// The store caught up with a drop (or moved on): the grid draws what it holds.
				droppedLayout: null,
				droppedKey: null,
				timeRange: model.timeRange ?? document.timeRange,
				charts: withCharts(model, document.widgets),
				// The toolbar's share dialog reads the shares too, so they load for an empty board as well.
				shares: model.shares === "Idle" ? "Loading" : model.shares,
			}
			// A new saved default re-renders the open cadence rows: Base UI drops their highlight and
			// focus falls back to the popup.
			const isDefaultChanged =
				model.refreshMenu.isOpen &&
				model.document !== null &&
				model.document.refreshIntervalSeconds !== document.refreshIntervalSeconds
			const refocus = isDefaultChanged
				? [
						Command.mapMessage(
							Menu.FocusMenuItem({ id: popupId(model.refreshMenu.id) }),
							(message) => Message.GotRefreshMenuMessage({ message }),
						),
					]
				: []
			const planned = withReplan(
				isDefaultChanged
					? { ...next, refreshMenu: { ...next.refreshMenu, highlighted: null } }
					: next,
				context,
				"Load",
			)
			const isFirstRead = model.shares === "Idle" && next.shares === "Loading"
			const seq = model.sharing.fetchSeq + 1
			const shares = isFirstRead ? [FetchShares({ dashboardId: model.dashboardId, seq })] : []
			return {
				...planned,
				model: isFirstRead
					? { ...planned.model, sharing: { ...planned.model.sharing, fetchSeq: seq } }
					: planned.model,
				commands: [...(planned.commands ?? []), ...shares, ...refocus],
			}
		},
	})

const sortStep = (model: Model, widgetId: string, field: string, isText: boolean): Return => {
	const current = model.tableSorts[widgetId] ?? { key: null, dir: "desc" as const }
	// `useSortState` with `resettable`: desc, then asc, then unsorted; text columns start ascending.
	const next =
		current.key === field
			? current.dir === "asc"
				? { key: null, dir: current.dir }
				: { key: field, dir: "asc" as const }
			: { key: field, dir: isText ? ("asc" as const) : ("desc" as const) }
	return { model: { ...model, tableSorts: { ...model.tableSorts, [widgetId]: next } } }
}

const timePickerStep = (model: Model, context: PageContext, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotTimePickerMessage({ message: inner }),
	)
	const updated = { ...model, timePicker: next.model }
	const timeRange = TimeRangePicker.dashboardTimeRangeOf(next.outMessage)
	if (timeRange === undefined) return { model: updated, commands }
	const isSame =
		model.timeRange !== null &&
		model.timeRange.type === "relative" &&
		timeRange.type === "relative" &&
		model.timeRange.value === timeRange.value
	if (isSame) return { model: updated, commands }
	const planned = withReplan({ ...updated, timeRange }, context, "Load")
	// `DashboardTimeRangeSync`: a picked range is written to the board.
	const save = SaveTimeRange({ orgId: context.orgId, dashboardId: model.dashboardId, timeRange })
	return { ...planned, commands: [...commands, ...(planned.commands ?? []), save] }
}

/** The "More dashboard actions" menu: tags, history, variables, groups, layout, share, export. */
const moreAction = (model: Model, context: PageContext, value: string): Return => {
	switch (value) {
		case "tags": {
			if (model.persistenceError !== null || model.document === null) return { model }
			const opened = TagEditor.open(model.tagEditor, model.document.name, model.document.tags ?? [])
			return {
				model: { ...model, tagEditor: opened.model },
				commands: Command.mapMessages(opened.commands ?? [], wrapTagEditor),
			}
		}
		case "history":
			return openHistory(model)
		case "variables":
			return model.persistenceError === null ? openVariablesManager(model) : { model }
		case "add-group":
			return model.persistenceError === null
				? {
						model,
						commands: [
							EditSections({
								orgId: context.orgId,
								dashboardId: model.dashboardId,
								edit: SectionEdit.AddSection(),
							}),
						],
					}
				: { model }
		case "auto-layout":
			return model.persistenceError === null
				? { model, commands: [AutoLayout({ orgId: context.orgId, dashboardId: model.dashboardId })] }
				: { model }
		case "share":
			return openShare(model)
		case "export":
			return {
				model,
				commands: [ExportDashboard({ orgId: context.orgId, dashboardId: model.dashboardId })],
			}
		default:
			return { model }
	}
}

/** A widget menu pick: configure, clone, create alert, delete. */
const widgetAction = (model: Model, context: PageContext, widgetId: string, value: string): Return => {
	const target = { orgId: context.orgId, dashboardId: model.dashboardId, widgetId }
	const move = moveTargetOf(value)
	if (move !== undefined)
		return model.persistenceError !== null
			? { model }
			: {
					model,
					commands: [
						EditSections({
							orgId: context.orgId,
							dashboardId: model.dashboardId,
							edit: SectionEdit.MoveWidget({ widgetId, target: move.target }),
						}),
					],
				}
	switch (value) {
		case "edit":
			return navigate(
				model,
				hrefOf(
					AppRoute.DashboardWidget({
						dashboardId: AppRoute.DashboardWidget.fields.dashboardId.make(model.dashboardId),
						widgetId,
						search: pickDashboardControlParams(model.search),
					}),
				),
			)
		case "clone":
			return { model, commands: [CloneWidget(target)] }
		case "delete": {
			const removed = model.document?.widgets.find((candidate) => candidate.id === widgetId)
			return removed === undefined
				? { model }
				: {
						model,
						commands: [RemoveWidget(target)],
						outMessage: PageOutMessage.RequestedToast({
							type: "default",
							title: "Widget removed",
							description: "",
							timeoutMs: 6000,
							action: null,
							rootAction: {
								label: "Undo",
								action: {
									_tag: "RestoreDashboardWidgets",
									orgId: context.orgId,
									dashboardId: model.dashboardId,
									widgets: [removed],
								},
							},
						}),
					}
		}
		case "alert": {
			const widget = model.document?.widgets.find((candidate) => candidate.id === widgetId)
			return widget === undefined
				? { model }
				: navigate(
						model,
						hrefOf(
							AppRoute.AlertsCreate({ search: createAlertSearch(model.dashboardId, widget) }),
						),
					)
		}
		case "embed":
			return openEmbed(model, widgetId)
		default:
			return { model }
	}
}

const titleSubmit = (model: Model, context: PageContext): Return => {
	const draft = model.titleDraft
	const name = model.document?.name ?? ""
	const closed = { ...model, titleDraft: null }
	if (draft === null) return { model: closed }
	const trimmed = draft.trim()
	return trimmed !== "" && trimmed !== name
		? {
				model: closed,
				commands: [
					RenameDashboard({ orgId: context.orgId, dashboardId: model.dashboardId, name: trimmed }),
				],
			}
		: { model: closed }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		UpdatedDashboard: (updated) =>
			updated.orgId === context.orgId ? receiveDocument(model, context, updated) : { model },
		CompletedReadClock: ({ nowMs }) =>
			withReplan({ ...model, nowMs }, context, model.refreshVersion > 0 ? "Refresh" : "Load"),
		MeasuredGrid: ({ width }) => ({ model: { ...model, gridWidth: width } }),
		MeasuredWidget: ({ widgetId, widthPx }) => {
			const slot = slotOf(model, widgetId)
			if (slot.widthPx === widthPx) return { model }
			const next = { ...model, widgets: { ...model.widgets, [widgetId]: { ...slot, widthPx } } }
			return slot.isRevealed ? withReplan(next, context, "Load") : { model: next }
		},
		ClickedNarrowRange: ({ widgetId }) => {
			const slot = slotOf(model, widgetId)
			return slot.isNarrowed === true
				? { model }
				: withReplan(
						{
							...model,
							widgets: { ...model.widgets, [widgetId]: { ...slot, isNarrowed: true } },
						},
						context,
						"Load",
					)
		},
		RevealedWidget: ({ widgetId }) => {
			const slot = slotOf(model, widgetId)
			return slot.isRevealed
				? { model }
				: withReplan(
						{
							...model,
							widgets: { ...model.widgets, [widgetId]: { ...slot, isRevealed: true } },
						},
						context,
						"Load",
					)
		},
		CompletedFetchVariableOptions: ({ name, key, result }) => {
			const slot = model.variableOptions[name]
			if (slot === undefined) return { model }
			// The options settle the variables, which may unblock tiles waiting on them.
			return withReplan(
				{
					...model,
					variableOptions: { ...model.variableOptions, [name]: Keyed.accept(slot, key, result) },
				},
				context,
				"Load",
			)
		},
		CompletedFetchWidget: ({ key, result }) => {
			const slot = model.requests[key]
			if (slot === undefined) return { model }
			// A stat that just got its value asks for its sparkline series next.
			return withReplan(
				{ ...model, requests: { ...model.requests, [key]: Keyed.accept(slot, key, result) } },
				context,
				"Load",
			)
		},
		GotShareMessage: ({ message: inner }) => shareStep(model, context, inner),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotChartMessage: ({ widgetId, message: inner }) => {
			const next = Chart.update(model.charts[widgetId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [widgetId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ widgetId, message: chart }),
				),
			}
		},
		ClickedSortColumn: ({ widgetId, field, isText }) => sortStep(model, widgetId, field, isText),
		GotTimePickerMessage: ({ message: inner }) => timePickerStep(model, context, inner),
		GotRefreshMenuMessage: ({ message: inner }) => {
			const next = menuStep(model.refreshMenu, inner, (menu) =>
				Message.GotRefreshMenuMessage({ message: menu }),
			)
			const updated = { ...model, refreshMenu: next.model }
			return Option.match(Option.flatMap(next.picked, decodeInterval), {
				onNone: () => ({ model: updated, commands: next.commands }),
				onSome: (seconds) => {
					const picked = pickRefreshInterval(updated, context, seconds)
					return { ...picked, commands: [...next.commands, ...(picked.commands ?? [])] }
				},
			})
		},
		TickedAutoRefresh: () => reload(model),
		ClickedReload: () => reload(model),
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedToggleEdit: () => toggleEdit(model),
		GotMoreMenuMessage: ({ message: inner }) => {
			const next = menuStep(model.moreMenu, inner, (menu) =>
				Message.GotMoreMenuMessage({ message: menu }),
			)
			const updated = { ...model, moreMenu: next.model }
			return Option.match(next.picked, {
				onNone: () => ({ model: updated, commands: next.commands }),
				onSome: (value) => {
					const action = moreAction(updated, context, value)
					return { ...action, commands: [...next.commands, ...(action.commands ?? [])] }
				},
			})
		},
		GotWidgetMenuMessage: ({ widgetId, message: inner }) => {
			const current =
				model.widgetMenuId === widgetId ? model.widgetMenu : Menu.init(widgetMenuIdOf(widgetId))
			const next = menuStep(current, inner, (menu) =>
				Message.GotWidgetMenuMessage({ widgetId, message: menu }),
			)
			const updated = { ...model, widgetMenuId: widgetId, widgetMenu: next.model }
			return Option.match(next.picked, {
				onNone: () => ({ model: updated, commands: next.commands }),
				onSome: (value) => {
					const action = widgetAction(updated, context, widgetId, value)
					return { ...action, commands: [...next.commands, ...(action.commands ?? [])] }
				},
			})
		},
		ClickedTitle: () =>
			model.persistenceError !== null || model.document === null || model.history.previewed !== null
				? { model }
				: { model: { ...model, titleDraft: model.document.name } },
		ChangedTitleDraft: ({ value }) => ({ model: { ...model, titleDraft: value } }),
		SubmittedTitle: () => titleSubmit(model, context),
		CancelledTitle: () => ({ model: { ...model, titleDraft: null } }),
		ClickedAddWidget: () => {
			const next = Dialog.open(model.pickerDialog)
			return {
				model: { ...model, pickerDialog: next.model, pickerTarget: null },
				commands: Command.mapMessages(next.commands ?? [], (dialog) =>
					Message.GotPickerDialogMessage({ message: dialog }),
				),
			}
		},
		GotPickerDialogMessage: ({ message: inner }) => {
			const next = Dialog.update(model.pickerDialog, inner)
			return {
				model: {
					...model,
					pickerDialog: next.model,
					pickerTarget: next.model.isOpen ? model.pickerTarget : null,
				},
				commands: Command.mapMessages(next.commands ?? [], (dialog) =>
					Message.GotPickerDialogMessage({ message: dialog }),
				),
			}
		},
		ClickedWidgetPreset: ({ presetId }) => addPicked(model, context, { presetId, chartId: null }),
		ClickedChartStyle: ({ chartId }) => addPicked(model, context, { presetId: null, chartId }),
		GotTagEditorMessage: ({ message: inner }) => {
			const next = TagEditor.update(model.tagEditor, inner)
			const commands = Command.mapMessages(next.commands ?? [], wrapTagEditor)
			const updated = { ...model, tagEditor: next.model }
			// Not gated on `persistenceError`: the dialog closed on Save, and a success clears the banner.
			return next.outMessage === undefined
				? { model: updated, commands }
				: {
						model: updated,
						commands: [
							...commands,
							SaveTags({
								orgId: context.orgId,
								dashboardId: model.dashboardId,
								tags: next.outMessage.tags,
							}),
						],
					}
		},
		UpdatedOrgTags: ({ tags }) => ({ model: { ...model, orgTags: tags } }),
		GotPickerTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.pickerTabs, inner)
			return {
				model: { ...model, pickerTabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tabs) =>
					Message.GotPickerTabsMessage({ message: tabs }),
				),
			}
		},
		PressedGrip: (pressed) => gestureStep(model, context, pressed),
		PressedResizeHandle: (pressed) => gestureStep(model, context, pressed),
		MovedPointer: (moved) => gestureStep(model, context, moved),
		ReleasedPointer: (released) => gestureStep(model, context, released),
		CancelledPointer: (cancelled) => gestureStep(model, context, cancelled),
		PressedGripKey: (pressed) => gestureStep(model, context, pressed),
		BlurredGrip: (blurred) => gestureStep(model, context, blurred),
		CompletedWrite: ({ result }) =>
			Result.match(result, {
				onFailure: (error) => closePicker({ ...model, persistenceError: error }),
				onSuccess: (sync) =>
					sync === "Behind"
						? { model, outMessage: behindToast() }
						: { model: { ...model, persistenceError: null } },
			}),
		CompletedExport: () => ({ model }),
		GotErrorDetailsMessage: ({ widgetId, message: inner }) => {
			const next = Popover.update(
				model.errorDetails[widgetId] ?? Popover.init(errorDetailsIdOf(widgetId)),
				inner,
			)
			return {
				model: { ...model, errorDetails: { ...model.errorDetails, [widgetId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (popover) =>
					Message.GotErrorDetailsMessage({ widgetId, message: popover }),
				),
			}
		},
		GotErrorCopyMessage: ({ widgetId, message: inner }) => {
			const next = CopyButton.update(model.errorCopies[widgetId] ?? CopyButton.init(), inner)
			return {
				model: { ...model, errorCopies: { ...model.errorCopies, [widgetId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (copy) =>
					Message.GotErrorCopyMessage({ widgetId, message: copy }),
				),
			}
		},
		GotVariableComboMessage: (m) => variableStep(model, context, m),
		ChangedVariableDraft: (m) => variableStep(model, context, m),
		CommittedVariableDraft: (m) => variableStep(model, context, m),
		ClickedManageVariables: () => openVariablesManager(model),
		GotVariablesManagerMessage: ({ message: inner }) => managerStep(model, context, inner),
		ClickedCloseHistory: (m) => replanAfter(historyStep(model, m), context),
		CompletedFetchVersions: (m) => replanAfter(historyStep(model, m), context),
		ClickedVersion: (m) => replanAfter(historyStep(model, m), context),
		CompletedFetchSnapshot: (m) => replanAfter(historyStep(model, m), context),
		ClickedCancelPreview: (m) => replanAfter(historyStep(model, m), context),
		ClickedRestoreVersion: (m) => replanAfter(historyStep(model, m), context),
		GotRestoreDialogMessage: (m) => replanAfter(historyStep(model, m), context),
		ConfirmedRestore: (m) => replanAfter(historyStep(model, m), context),
		CompletedRestore: (m) => replanAfter(historyStep(model, m), context),
		ClickedSectionChevron: (m) => sectionStep(model, context, m),
		ClickedSectionTab: (m) => sectionStep(model, context, m),
		ClickedAddSectionWidget: (m) => sectionStep(model, context, m),
		GotSectionMenuMessage: (m) => sectionStep(model, context, m),
		StartedRename: (m) => sectionStep(model, context, m),
		ChangedRenameDraft: (m) => sectionStep(model, context, m),
		SubmittedRename: (m) => sectionStep(model, context, m),
		CancelledRename: (m) => sectionStep(model, context, m),
		ClickedAddTab: (m) => sectionStep(model, context, m),
		ClickedDeleteTab: (m) => sectionStep(model, context, m),
		GotSectionDialogMessage: (m) => sectionStep(model, context, m),
		GotTabDialogMessage: (m) => sectionStep(model, context, m),
		ConfirmedDeleteSection: (m) => sectionStep(model, context, m),
		ConfirmedDeleteTab: (m) => sectionStep(model, context, m),
	})

export const errorDetailsIdOf = (widgetId: string): string => `dashboard-error-details-${widgetId}`

export const widgetMenuIdOf = (widgetId: string): string => `dashboard-widget-menu-${widgetId}`
