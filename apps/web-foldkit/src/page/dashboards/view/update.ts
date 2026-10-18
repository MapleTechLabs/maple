import { pickDashboardControlParams } from "@maple/web/lib/dashboard-controls/search-params"
import { Option, Result } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { AppRoute, hrefOf } from "../../../route"
import type { DashboardSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CloneWidget,
	CompleteReloadSpin,
	ExportDashboard,
	FetchShares,
	ReadClock,
	RemoveWidget,
	RenameDashboard,
	RestoreWidget,
	SaveTimeRange,
} from "./command"
import { gestureStep } from "./gesture"
import { Message } from "./message"
import type { Model } from "./model"
import { replan, slotOf, withCharts } from "./plan"
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
		gesture: null,
		persistenceError: null,
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

export const routeChanged = (model: Model, route: Route): Return => ({
	model: { ...model, search: route.search },
})

/** `mode`: edit only from the URL, and never while writes are unavailable. */
export const isEditing = (model: Model): boolean =>
	model.search.mode === "edit" && model.persistenceError === null

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
				timeRange: model.timeRange ?? document.timeRange,
				charts: withCharts(model, document.widgets),
				// The toolbar's share dialog reads the shares too, so they load for an empty board as well.
				shares: model.shares === "Idle" ? "Loading" : model.shares,
			}
			const planned = withReplan(next, context, "Load")
			const shares =
				model.shares === "Idle" && next.shares === "Loading"
					? [FetchShares({ dashboardId: model.dashboardId })]
					: []
			return { ...planned, commands: [...(planned.commands ?? []), ...shares] }
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
	if (next.outMessage === undefined) return { model: updated, commands }
	const timeRange = { type: "relative" as const, value: next.outMessage.presetValue }
	const isSame =
		model.timeRange !== null &&
		model.timeRange.type === "relative" &&
		model.timeRange.value === timeRange.value
	if (isSame) return { model: updated, commands }
	const planned = withReplan({ ...updated, timeRange }, context, "Load")
	// `DashboardTimeRangeSync`: a picked range is written to the board.
	const save = SaveTimeRange({ orgId: context.orgId, dashboardId: model.dashboardId, timeRange })
	return { ...planned, commands: [...commands, ...(planned.commands ?? []), save] }
}

const menuStep = (
	menu: Menu.Model,
	message: Menu.Message,
	wrap: (message: Menu.Message) => Message,
): {
	model: Menu.Model
	commands: ReadonlyArray<Command.Command<Message>>
	picked: Option.Option<string>
} => {
	const next = Menu.update(menu, message)
	const out = next.outMessage
	return {
		model: next.model,
		commands: Command.mapMessages(next.commands ?? [], wrap),
		picked:
			out === undefined
				? Option.none()
				: Option.some(out._tag === "SelectedSubmenuItem" ? out.value : out.value),
	}
}

/** The "More dashboard actions" menu. TODO(toolbar): share, history, variables, tags, groups. */
const moreAction = (model: Model, context: PageContext, value: string): Return => {
	switch (value) {
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
							action: {
								label: "Undo",
								message: Message.ClickedUndoRemoveWidget({ widget: removed }),
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
		CompletedFetchWidget: ({ key, result }) => {
			const slot = model.requests[key]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							requests: { ...model.requests, [key]: Keyed.accept(slot, key, result) },
						},
					}
		},
		CompletedFetchShares: ({ dashboardId }) =>
			dashboardId === model.dashboardId ? { model: { ...model, shares: "Loaded" } } : { model },
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
			// TODO(auto-refresh): the cadence menu opens and closes; picking an interval is not wired.
			const next = menuStep(model.refreshMenu, inner, (menu) =>
				Message.GotRefreshMenuMessage({ message: menu }),
			)
			return { model: { ...model, refreshMenu: next.model }, commands: next.commands }
		},
		ClickedReload: () => {
			const refreshVersion = model.refreshVersion + 1
			return {
				model: { ...model, refreshVersion, isReloading: true },
				commands: [ReadClock(), CompleteReloadSpin({ version: refreshVersion })],
			}
		},
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
			model.persistenceError !== null || model.document === null
				? { model }
				: { model: { ...model, titleDraft: model.document.name } },
		ChangedTitleDraft: ({ value }) => ({ model: { ...model, titleDraft: value } }),
		SubmittedTitle: () => titleSubmit(model, context),
		CancelledTitle: () => ({ model: { ...model, titleDraft: null } }),
		ClickedAddWidget: () => {
			// TODO(widget-picker): the picker dialog opens empty; presets are not ported yet.
			const next = Dialog.open(model.pickerDialog)
			return {
				model: { ...model, pickerDialog: next.model },
				commands: Command.mapMessages(next.commands ?? [], (dialog) =>
					Message.GotPickerDialogMessage({ message: dialog }),
				),
			}
		},
		GotPickerDialogMessage: ({ message: inner }) => {
			const next = Dialog.update(model.pickerDialog, inner)
			return {
				model: { ...model, pickerDialog: next.model },
				commands: Command.mapMessages(next.commands ?? [], (dialog) =>
					Message.GotPickerDialogMessage({ message: dialog }),
				),
			}
		},
		ClickedWidgetPreset: () => ({ model }),
		PressedGrip: (pressed) => gestureStep(model, context, pressed),
		PressedResizeHandle: (pressed) => gestureStep(model, context, pressed),
		MovedPointer: (moved) => gestureStep(model, context, moved),
		ReleasedPointer: (released) => gestureStep(model, context, released),
		CompletedWrite: ({ result }) =>
			Result.match(result, {
				onFailure: (error) => ({ model: { ...model, persistenceError: error } }),
				onSuccess: () => ({ model: { ...model, persistenceError: null } }),
			}),
		CompletedExport: () => ({ model }),
		ClickedUndoRemoveWidget: ({ widget }) => ({
			model,
			commands: [RestoreWidget({ orgId: context.orgId, dashboardId: model.dashboardId, widget })],
		}),
	})

export const widgetMenuIdOf = (widgetId: string): string => `dashboard-widget-menu-${widgetId}`
