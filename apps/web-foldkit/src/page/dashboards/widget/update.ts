import { pickDashboardControlParams } from "@maple/web/lib/dashboard-controls/search-params"
import {
	computeBucketSecondsForWidthRange,
	formatBucketSecondsShort,
	resolveTimeRangeWindow,
} from "@maple/query-engine"
import { Option } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { AUTOCOMPLETE_LOOKUPS } from "../../kit/autocomplete-lookups"
import { AppRoute, hrefOf } from "../../../route"
import type { DashboardWidgetSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { DEFAULT_WIDGET_WIDTH_PX, maxDataPointsForWidth, toPanelType } from "../kit/chart-registry"
import { planWidget } from "../kit/widget-data"
import { FetchAutocomplete, FetchWidget, ReadClock } from "./command"
import type { EditorState } from "./editor-state"
import { buildDataSource, buildDisplay, toInitialState, type Widget } from "./lowering"
import { Message } from "./message"
import type { Model } from "./model"

export type Return = PageReturn<Model, Message>
type Search = typeof DashboardWidgetSearch.Type
type Route = Readonly<{ dashboardId: string; widgetId: string; search: Search }>

export const SOURCE_MODES = ["builder", "rawSql"]

export const init = (route: Route, _context: PageContext): Return => ({
	model: {
		dashboardId: route.dashboardId,
		widgetId: route.widgetId,
		search: route.search,
		status: "Loading",
		document: null,
		state: null,
		initial: null,
		staged: null,
		sourceMode: "builder",
		timeRange: null,
		nowMs: null,
		previewWidth: null,
		gate: null,
		requests: {},
		chart: Chart.init(),
		tableSort: { key: null, dir: "desc" },
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		timePicker: TimeRangePicker.init("widget-editor-time-range"),
		sourceTabs: Tabs.init({ idBase: 0, values: SOURCE_MODES, selected: "builder" }),
		selects: {},
		groupBys: {},
		collapsed: [],
		isAutocompleteActive: false,
		autocomplete: {},
		isSaving: false,
		leaveDialog: Dialog.init("widget-editor-leave-dialog", "alert-dialog"),
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

export const widgetOf = (model: Model): Widget | null =>
	model.document?.widgets.find((widget) => widget.id === model.widgetId) ?? null

/** `navigateBack`: the dashboard in edit mode, with the controls the editor carried. */
export const backHref = (model: Model): string =>
	hrefOf(
		AppRoute.Dashboard({
			dashboardId: AppRoute.Dashboard.fields.dashboardId.make(model.dashboardId),
			search: { ...pickDashboardControlParams(model.search), mode: "edit" },
		}),
	)

/**
 * `previewWidget`: the staged queries with the live presentation (type, legend, stats, points),
 * so those apply without Run preview.
 */
export const previewWidgetOf = (model: Model): Widget | null => {
	const widget = widgetOf(model)
	if (widget === null || model.state === null || model.staged === null) return null
	const state = model.state
	const preview: EditorState = {
		...model.staged,
		visualization: state.visualization,
		chartId: state.chartId,
		legendPosition: state.legendPosition,
		seriesStatsEnabled: state.seriesStatsEnabled,
		pointsMode: state.pointsMode,
	}
	return {
		...widget,
		timeRange: state.timeRange ?? undefined,
		visualization: state.visualization,
		dataSource: buildDataSource(preview),
		display: buildDisplay(widget, preview),
	}
}

/** The preview's request against the board's window; a key already held is not asked again. */
export const planPreview = (model: Model, context: PageContext): Return => {
	const widget = previewWidgetOf(model)
	if (widget === null || model.timeRange === null || model.nowMs === null) return { model }
	const window = resolveTimeRangeWindow(model.timeRange, {
		snap: true,
		timeZone: context.timeZone,
		nowMs: model.nowMs,
	})
	const panel = toPanelType(widget.visualization, widget.display.chartId)
	const gate = planWidget({
		orgId: context.orgId,
		dataSource: widget.dataSource,
		window,
		...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
		maxDataPoints: maxDataPointsForWidth(model.previewWidth ?? DEFAULT_WIDGET_WIDTH_PX, panel),
	})
	const next = { ...model, gate }
	if (gate._tag !== "Request") return { model: next }
	const { key, endpoint, params } = gate.request
	return Option.match(Keyed.request(model.requests[key] ?? Keyed.idle(), key, "Load"), {
		onNone: () => ({ model: next }),
		onSome: (slot) => ({
			model: { ...next, requests: { ...model.requests, [key]: slot } },
			commands: [FetchWidget({ key, endpoint, params })],
		}),
	})
}

/** The stored widget arrived: the editor state is seeded once, the preview planned. */
export const receiveDocument = (
	model: Model,
	context: PageContext,
	message: Message & { _tag: "UpdatedDashboard" },
): Return =>
	Option.match(message.maybeDocument, {
		onNone: () => ({ model: { ...model, status: "Missing", document: null } }),
		onSome: (document) => {
			const widget = document.widgets.find((candidate) => candidate.id === model.widgetId)
			if (widget === undefined) return { model: { ...model, status: "Missing", document } }
			const seeded = model.state ?? toInitialState(widget)
			return planPreview(
				{
					...model,
					status: "Ready",
					document,
					timeRange: model.timeRange ?? document.timeRange,
					state: seeded,
					initial: model.initial ?? seeded,
					staged: model.staged ?? seeded,
				},
				context,
			)
		},
	})

/** An edit to the editing state; a presentation edit re-plans the preview. */
export const editState = (
	model: Model,
	context: PageContext,
	edit: (state: EditorState) => EditorState,
): Return => (model.state === null ? { model } : planPreview({ ...model, state: edit(model.state) }, context))

/** `isDirty`: the source tab moved, or the state differs from what was opened. */
export const isDirty = (model: Model): boolean =>
	model.sourceMode !== "builder" || JSON.stringify(model.state) !== JSON.stringify(model.initial)

export const navigate = (model: Model, url: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
})

/** `useBlocker`: leaving with unsaved edits asks first. */
export const leave = (model: Model, url: string): Return => {
	if (model.isSaving || !isDirty(model)) return navigate(model, url)
	const next = Dialog.open(model.leaveDialog)
	return {
		model: { ...model, leaveDialog: next.model },
		commands: Command.mapMessages(next.commands ?? [], (message) =>
			Message.GotLeaveDialogMessage({ message }),
		),
	}
}

/** The widget Apply writes: the stored widget with the edited type, source and display. */
export const editedWidget = (widget: Widget, state: EditorState): Widget => {
	const edited: Widget = {
		...widget,
		visualization: state.visualization,
		dataSource: buildDataSource(state),
		display: buildDisplay(widget, state),
	}
	if (state.timeRange !== null) return { ...edited, timeRange: state.timeRange }
	// No override: the key goes, so the widget follows the dashboard again.
	const { timeRange: _dropped, ...followsDashboard } = edited
	return followsDashboard
}

/** The interval placeholder's "Auto (2m)": the bucket the preview resolves to right now. */
export const autoIntervalLabel = (model: Model, timeZone: string): string => {
	const range = model.state?.timeRange ?? model.timeRange
	if (range === null || model.nowMs === null || model.state === null) return "Auto"
	const window = resolveTimeRangeWindow(range, { snap: true, timeZone, nowMs: model.nowMs })
	if (window === null) return "Auto"
	const panel = toPanelType(model.state.visualization, model.state.chartId)
	const seconds = computeBucketSecondsForWidthRange(window.startTime, window.endTime, {
		maxDataPoints: maxDataPointsForWidth(model.previewWidth ?? DEFAULT_WIDGET_WIDTH_PX, panel),
	})
	return `Auto (${formatBucketSecondsShort(seconds)})`
}

/** The provider's lookups over the board's window, once active; a held key is not asked again. */
export const requestAutocomplete = (model: Model, context: PageContext): Return => {
	if (!model.isAutocompleteActive || model.timeRange === null || model.nowMs === null) return { model }
	const window = resolveTimeRangeWindow(model.timeRange, {
		snap: true,
		timeZone: context.timeZone,
		nowMs: model.nowMs,
	})
	if (window === null) return { model }
	const range = { startTime: window.startTime, endTime: window.endTime }
	return AUTOCOMPLETE_LOOKUPS.reduce<Return>(
		(step, lookup) => {
			const key = requestKey(context.orgId, `autocomplete.${lookup}`, range)
			return Option.match(Keyed.request(step.model.autocomplete[lookup] ?? Keyed.idle(), key, "Load"), {
				onNone: () => step,
				onSome: (slot) => ({
					model: { ...step.model, autocomplete: { ...step.model.autocomplete, [lookup]: slot } },
					commands: [...(step.commands ?? []), FetchAutocomplete({ key, lookup, window: range })],
				}),
			})
		},
		{ model, commands: [] },
	)
}
