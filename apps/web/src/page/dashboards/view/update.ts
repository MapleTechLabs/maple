import {
	pickDashboardControlParams,
	timeRangeParams,
	variableValuesFromSearch,
} from "../../../lib/dashboard-controls/search-params"
import { behindToast } from "../kit/store"
import { type DashboardDocument, DashboardRefreshIntervalSeconds } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { AppRoute, hrefOf } from "../../../route"
import type { DashboardSearch } from "../../../route/search"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Combobox from "@maple/views/ui/combobox"
import * as Popover from "@maple/views/ui/popover"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Tabs from "@maple/views/ui/tabs"
import { popupId } from "@maple/views/ui/overlay/popup-state"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CloneWidget,
	EditSections,
	CompleteReloadSpin,
	ExportDashboard,
	FetchShares,
	ReadClock,
	ReloadPage,
	RemoveWidget,
	RenameDashboard,
	AddWidget,
	AutoLayout,
	SaveTags,
	SaveRefreshInterval,
	SaveTimeRange,
} from "./command"
import { cancelStaleGesture, gestureStep } from "./gesture"
import { receiveLayoutWrite, retryLayoutWrite, settleLayoutWrite } from "./layout-commit"
import { Message } from "./message"
import type { Model, Snapshot } from "./model"
import { FallbackReason, FetchDashboardFallback } from "./command-fallback"
import {
	awaitsRefresh,
	isSameTimeRange,
	replan,
	replanTile,
	shownDocumentOf,
	slotOf,
	timeRangeOf,
	viewerTimeRangeOf,
	withCharts,
} from "./plan"
import { isEditing, isWriteBlocked } from "./mode"
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
		snapshot: { _tag: "Idle" },
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
		pickerTabs: Tabs.init({
			idBase: 300,
			values: Arr.map(PICKER_TABS, (tab) => tab.id),
			selected: "all",
		}),
		gesture: null,
		keyboardMove: null,
		gridAnnouncement: "",
		layoutWrite: null,
		nextLayoutGeneration: 0,
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
	Rec.keys(a).length === Rec.keys(b).length &&
	Arr.every(Rec.toEntries(a), ([key, value]) => b[key] === value)

/** The shown range moved after entry: plan on a fresh clock, not the one read when the page opened. */
const isRangeMoved = (before: Model, after: Model): boolean => {
	const range = timeRangeOf(before)
	return after.nowMs !== null && range !== null && !isSameTimeRange(range, timeRangeOf(after))
}

/** A `var-*` change re-plans the tiles that read the variable; a `range` change reads the clock first. */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	const next = { ...model, search: route.search }
	if (isRangeMoved(model, next)) return { model: next, commands: [ReadClock()] }
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

/** `handleToggleEdit`: the per-viewer controls survive, except a viewer's range, which editing replaces. */
const toggleEdit = (model: Model): Return =>
	navigate(
		model,
		isEditing(model)
			? dashboardHref(model, pickDashboardControlParams(model.search))
			: editModeHref(model),
	)

/** Entering edit mode: the viewer controls survive, except a viewer's range (edit works on the board's). */
const editModeHref = (model: Model): string => {
	const { range: _range, from: _from, to: _to, ...kept } = pickDashboardControlParams(model.search)
	return dashboardHref(model, { ...kept, mode: "edit" })
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
	if (isWriteBlocked(model)) {
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
					url: editModeHref(model),
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

/** A step that changed one tile's slot: only that tile is planned again. */
const withTileReplan = (model: Model, context: PageContext, widgetId: string): Return => {
	const planned = replanTile(model, context, widgetId, "Load")
	return { model: planned.model, commands: planned.commands }
}

/**
 * The document arrived (or changed): plan the revealed tiles against it. The live stream always
 * wins: its answer replaces a shown HTTP snapshot, and editing comes back.
 */
const receiveDocument = (
	model: Model,
	context: PageContext,
	maybeDocument: Option.Option<DashboardDocument>,
	snapshot: Snapshot,
): Return =>
	Option.match(maybeDocument, {
		onNone: () => ({ model: { ...model, status: "Missing", document: null, snapshot } }),
		onSome: (document) => {
			const next: Model = {
				...model,
				status: "Ready",
				document,
				snapshot,
				layoutWrite: receiveLayoutWrite(model.layoutWrite, document),
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
			const settled = isDefaultChanged
				? { ...next, refreshMenu: { ...next.refreshMenu, highlighted: null } }
				: next
			// A tile moved to another container mid-gesture: the gesture ends where it began.
			const ended = cancelStaleGesture(settled, context)
			// A new saved range this viewer shows: the clock is read first, and its answer plans.
			const replanned: Return = isRangeMoved(model, ended.model)
				? { model: ended.model, commands: [ReadClock()] }
				: withReplan(ended.model, context, "Load")
			const planned: Return = {
				...replanned,
				commands: [...(ended.commands ?? []), ...(replanned.commands ?? [])],
			}
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

/** The board over HTTP while live sync is down; the org's collections reconnect meanwhile. */
const readSnapshot = (model: Model, reason: typeof FallbackReason.Type): Return => ({
	model: { ...model, status: "Loading", snapshot: { _tag: "Loading" } },
	commands: [FetchDashboardFallback({ dashboardId: model.dashboardId, reason })],
	outMessage: PageOutMessage.RequestedReconnectOrgCollections(),
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
	// Only an edit session saves the pick as the board's range; a viewer's pick stays in their URL.
	const save =
		isEditing(model) && !isSameTimeRange(model.document?.timeRange ?? null, timeRange)
			? [SaveTimeRange({ orgId: context.orgId, dashboardId: model.dashboardId, timeRange })]
			: []
	// The saved board answers through the document; the URL holds a viewer's pick, even one equal to the board's.
	if (isEditing(model) || isSameTimeRange(viewerTimeRangeOf(model), timeRange))
		return { model: updated, commands: [...commands, ...save] }
	const controls = { ...pickDashboardControlParams(model.search), ...timeRangeParams(timeRange) }
	const search = model.search.mode === "edit" ? { ...controls, mode: "edit" as const } : controls
	return {
		model: updated,
		commands: [...commands, ...save],
		outMessage: PageOutMessage.RequestedNavigation({
			url: dashboardHref(model, search),
			isReplace: true,
		}),
	}
}

/** The "More dashboard actions" menu: tags, history, variables, groups, layout, share, export. */
const moreAction = (model: Model, context: PageContext, value: string): Return => {
	switch (value) {
		case "tags": {
			if (!isEditing(model) || model.document === null) return { model }
			const opened = TagEditor.open(model.tagEditor, model.document.name, model.document.tags ?? [])
			return {
				model: { ...model, tagEditor: opened.model },
				commands: Command.mapMessages(opened.commands ?? [], wrapTagEditor),
			}
		}
		case "history":
			return openHistory(model)
		case "variables":
			return isEditing(model) ? openVariablesManager(model) : { model }
		case "add-group":
			return isEditing(model)
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
			return isEditing(model)
				? { model, commands: [AutoLayout({ orgId: context.orgId, dashboardId: model.dashboardId })] }
				: { model }
		case "share":
			return openShare(model)
		case "export":
			// A preview still loading has no snapshot yet; exporting now would export the live board.
			if (model.history.previewed !== null && shownDocumentOf(model) === null) return { model }
			return {
				model,
				commands: [
					ExportDashboard({
						orgId: context.orgId,
						dashboardId: model.dashboardId,
						snapshot: model.history.previewed === null ? null : shownDocumentOf(model),
					}),
				],
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
		return !isEditing(model)
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
			return isEditing(model) ? { model, commands: [CloneWidget(target)] } : { model }
		case "delete": {
			const removed = Arr.findFirst(
				model.document?.widgets ?? [],
				(candidate) => candidate.id === widgetId,
			)
			return Option.isNone(removed) || !isEditing(model)
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
									widgets: [removed.value],
								},
							},
						}),
					}
		}
		case "alert": {
			return Option.match(
				Arr.findFirst(
					shownDocumentOf(model)?.widgets ?? [],
					(candidate) => candidate.id === widgetId,
				),
				{
					onNone: (): Return => ({ model }),
					onSome: (widget) =>
						navigate(
							model,
							hrefOf(
								AppRoute.AlertsCreate({
									search: createAlertSearch(model.dashboardId, widget),
								}),
							),
						),
				},
			)
		}
		case "embed":
			return model.history.previewed === null ? openEmbed(model, widgetId) : { model }
		default:
			return { model }
	}
}

const titleSubmit = (model: Model, context: PageContext): Return => {
	const draft = model.titleDraft
	const name = model.document?.name ?? ""
	const closed = { ...model, titleDraft: null }
	if (draft === null) return { model: closed }
	const trimmed = Str.trim(draft)
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
			updated.orgId === context.orgId
				? receiveDocument(model, context, updated.maybeDocument, { _tag: "Idle" })
				: { model },
		// `handleCollectionStuck`: the collections reconnect while the snapshot loads.
		TimedOutLiveDashboard: ({ orgId }) =>
			orgId !== context.orgId || model.status !== "Loading" || model.snapshot._tag !== "Idle"
				? { model }
				: readSnapshot(model, "live_sync_timeout"),
		// A late answer after the stream delivered is dropped: the live board is newer.
		CompletedFetchDashboardFallback: ({ dashboardId, result }) =>
			dashboardId !== model.dashboardId || model.snapshot._tag !== "Loading"
				? { model }
				: Result.match(result, {
						onSuccess: (document) =>
							receiveDocument(model, context, Option.some(document), { _tag: "Shown" }),
						onFailure: (failure) =>
							failure.code === "dashboard_not_found"
								? receiveDocument(model, context, Option.none(), { _tag: "Idle" })
								: {
										model: {
											...model,
											status: "Failed",
											snapshot: { _tag: "Failed", failure },
										},
									},
					}),
		// `retryOrgCollections`: a board that could not be read is read again after the reconnect.
		ClickedRetrySync: () =>
			model.status === "Failed"
				? readSnapshot(model, "retry")
				: { model, outMessage: PageOutMessage.RequestedReconnectOrgCollections() },
		CompletedReadClock: ({ nowMs }) =>
			withReplan({ ...model, nowMs }, context, model.refreshVersion > 0 ? "Refresh" : "Load"),
		MeasuredGrid: ({ width }) => cancelStaleGesture({ ...model, gridWidth: width }, context),
		MeasuredWidget: ({ widgetId, widthPx }) => {
			const slot = slotOf(model, widgetId)
			if (slot.widthPx === widthPx) return { model }
			const next = { ...model, widgets: { ...model.widgets, [widgetId]: { ...slot, widthPx } } }
			return slot.isRevealed ? withTileReplan(next, context, widgetId) : { model: next }
		},
		ClickedNarrowRange: ({ widgetId }) => {
			const slot = slotOf(model, widgetId)
			return slot.isNarrowed === true
				? { model }
				: withTileReplan(
						{
							...model,
							widgets: { ...model.widgets, [widgetId]: { ...slot, isNarrowed: true } },
						},
						context,
						widgetId,
					)
		},
		RevealedWidget: ({ widgetId }) => {
			const slot = slotOf(model, widgetId)
			return slot.isRevealed && slot.isOffscreen !== true
				? { model }
				: withTileReplan(
						{
							...model,
							widgets: {
								...model.widgets,
								[widgetId]: { ...slot, isRevealed: true, isOffscreen: false },
							},
						},
						context,
						widgetId,
					)
		},
		HidWidget: ({ widgetId }) => {
			const slot = slotOf(model, widgetId)
			return !slot.isRevealed || slot.isOffscreen === true
				? { model }
				: {
						model: {
							...model,
							widgets: { ...model.widgets, [widgetId]: { ...slot, isOffscreen: true } },
						},
					}
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
			const accepted = {
				...model,
				requests: { ...model.requests, [key]: Keyed.accept(slot, key, result) },
			}
			// Sparklines are planned with their stat; only a refresh deferred on this answer re-plans.
			return awaitsRefresh(model, key) ? withReplan(accepted, context, "Load") : { model: accepted }
		},
		GotShareMessage: ({ message: inner }) => shareStep(model, context, inner),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ClickedReloadPage: () => ({ model, commands: [ReloadPage()] }),
		ReloadedPage: () => ({ model }),
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
			isWriteBlocked(model) || model.document === null || model.history.previewed !== null
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
		CompletedLayoutWrite: ({ generation, result }) => {
			const settled = settleLayoutWrite(model, generation, Result.isSuccess(result), model.document)
			if (settled === null) return { model }
			return Result.match(result, {
				onFailure: (error) => closePicker({ ...settled, persistenceError: error }),
				onSuccess: (sync) =>
					sync === "Behind"
						? { model: settled, outMessage: behindToast() }
						: { model: { ...settled, persistenceError: null } },
			})
		},
		ClickedRetryPersistence: () => retryLayoutWrite({ ...model, persistenceError: null }, context),
		CameBackOnline: () => retryLayoutWrite({ ...model, persistenceError: null }, context),
		CompletedExport: ({ error }) =>
			error === null
				? { model }
				: {
						model,
						outMessage: PageOutMessage.RequestedToast({
							type: "error",
							title: "Couldn't export the dashboard",
							description: error,
						}),
					},
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
