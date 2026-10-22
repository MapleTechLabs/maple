import { initWhereFields } from "../../kit/where-field"
import { pickDashboardControlParams } from "../../../lib/dashboard-controls/search-params"
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
import * as Tooltip from "../../../ui/tooltip"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as QueryPanel from "../../kit/query-builder/panel"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { DEFAULT_WIDGET_WIDTH_PX, maxDataPointsForWidth, toPanelType } from "../kit/chart-registry"
import { planWidget } from "../kit/widget-data"
import { dataStateOf } from "../kit/data-state"
import { FetchAutocomplete, FetchVariableOptions, FetchWidget, ReadClock } from "./command"
import { planOptionRequests, planVariablesOf } from "../kit/variables"
import type { EditorState } from "./editor-state"
import { buildDataSource, buildDisplay, toInitialState, validationErrorOf, type Widget } from "./lowering"
import { initRawSql, type RawSqlDraft, rawSqlDataSourceOf } from "./raw-sql"
import { askMetricOptions } from "./metric-options"
import { eventNamesKeyOf, requestSuggestions } from "./product-step"
import { dataSourceRawSql } from "@maple/widgets/dashboard"
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
		initialSourceMode: "builder",
		rawSql: null,
		timeRange: null,
		nowMs: null,
		previewWidth: null,
		gate: null,
		sparkGate: null,
		sparklineChart: Chart.init(),
		requests: {},
		variableOptions: {},
		chart: Chart.init(),
		tableSort: { key: null, dir: "desc" },
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		timePicker: TimeRangePicker.init("widget-editor-time-range"),
		rangePicker: TimeRangePicker.init("widget-editor-widget-time-range"),
		sourceTabs: Tabs.init({ idBase: 0, values: SOURCE_MODES, selected: "builder" }),
		selects: {},
		queryPanels: QueryPanel.init("widget-editor"),
		metricSearch: "",
		metricOptions: null,
		metricRequested: null,
		metricKeys: {},
		metricKeysRequested: [],
		isAutocompleteActive: false,
		autocomplete: {},
		suggestions: {},
		stepCombos: {},
		whereFields: initWhereFields(),
		listFieldFocus: null,
		isProductPanelCollapsed: false,
		breakdownAttribute: { isActive: false, key: "" },
		sqlChipTooltip: Tooltip.init("widget-sql-chip-tooltip"),
		isSaving: false,
		leaveDialog: Dialog.init("widget-editor-leave-dialog", "alert-dialog"),
		pendingLeaveUrl: null,
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
		markdownContent: state.markdownContent,
		// The funnel's view and step labels are presentation too; its steps stay staged.
		funnel: {
			...model.staged.funnel,
			variant: state.funnel.variant,
			showStepPercent: state.funnel.showStepPercent,
		},
		queries: listPreviewQueries(model.staged.queries, state, model.staged, widget),
	}
	return {
		...widget,
		timeRange: state.timeRange ?? undefined,
		visualization: state.visualization,
		dataSource:
			isSqlSource(model) && model.rawSql !== null
				? rawSqlDataSourceOf(widget, model.rawSql.staged, state)
				: buildDataSource(preview),
		// The SQL's display follows the editing state; the builder's, its staged queries.
		display: buildDisplay(widget, isSqlSource(model) ? state : preview),
	}
}

/** FNV-1a over a string: a short, pure revision tag. */
const revisionOf = (text: string): string =>
	Array.from(text)
		.reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261)
		.toString(36)

/**
 * The list builds its engine query from a fresh `createQueryDraft(0)` each time the preview
 * recomputes (any edit, or the stored widget changing), so each recompute is a new request.
 */
const listPreviewQueries = (
	queries: EditorState["queries"],
	state: EditorState,
	staged: EditorState,
	widget: Widget,
): EditorState["queries"] => {
	const [first, ...rest] = queries
	if (state.visualization !== "list" || first === undefined) return queries
	return [{ ...first, id: `${first.id}:${revisionOf(JSON.stringify([state, staged, widget]))}` }, ...rest]
}

/** The preview's requests, and the metric list while a query reads metrics. */
export const planPreview = (model: Model, context: PageContext): Return => {
	const metrics = askMetricOptions(model)
	const planned = planWidgetPreview(metrics.model, context)
	const suggested = requestSuggestions(planned.model, context)
	return {
		model: suggested.model,
		commands: [...metrics.commands, ...(planned.commands ?? []), ...(suggested.commands ?? [])],
	}
}

const planWidgetPreview = (model: Model, context: PageContext): Return => {
	const widget = previewWidgetOf(model)
	if (widget === null || model.timeRange === null || model.nowMs === null) return { model }
	const window = resolveTimeRangeWindow(model.timeRange, {
		snap: true,
		timeZone: context.timeZone,
		nowMs: model.nowMs,
	})
	// `DashboardVariablesProvider` with no URL values: `$name` previews at the variable's default.
	const definitions = model.document?.variables ?? []
	const options = planOptionRequests(context.orgId, definitions, model.variableOptions, window, "Load")
	const variables = planVariablesOf(context.orgId, definitions, {}, options.slots, window)
	const optionCommands = options.requests.map((request) => FetchVariableOptions(request))
	const planned = planWidgetGates(
		{ ...model, variableOptions: options.slots },
		context,
		widget,
		window,
		variables,
	)
	return { model: planned.model, commands: [...optionCommands, ...planned.commands] }
}

const planWidgetGates = (
	model: Model,
	context: PageContext,
	widget: Widget,
	window: ReturnType<typeof resolveTimeRangeWindow>,
	variables: ReturnType<typeof planVariablesOf>,
): Planned => {
	const panel = toPanelType(widget.visualization, widget.display.chartId)
	const gate = planWidget({
		orgId: context.orgId,
		dataSource: widget.dataSource,
		window,
		...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
		maxDataPoints: maxDataPointsForWidth(model.previewWidth ?? DEFAULT_WIDGET_WIDTH_PX, panel),
		variables,
	})
	const asked = ask({ model: { ...model, gate }, commands: [] }, gate)
	// `StatSparklineLoader`: the trend is asked for once the stat itself has its value.
	const sparkline = widget.display.sparkline
	const sparkGate =
		panel === "stat" &&
		sparkline?.enabled === true &&
		sparkline.dataSource !== undefined &&
		dataStateOf(asked.model.requests, widget, gate)._tag === "Ready"
			? planWidget({
					orgId: context.orgId,
					dataSource: sparkline.dataSource,
					window,
					...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
					variables,
				})
			: null
	const withSpark = { ...asked, model: { ...asked.model, sparkGate } }
	return sparkGate === null ? withSpark : ask(withSpark, sparkGate)
}

type Planned = Readonly<{ model: Model; commands: ReadonlyArray<ReturnType<typeof FetchWidget>> }>

/** A gate's request asked for unless its key is already held. */
const ask = (planned: Planned, gate: Model["gate"]): Planned => {
	if (gate === null || gate._tag !== "Request") return planned
	const { key, endpoint, params } = gate.request
	return Option.match(Keyed.request(planned.model.requests[key] ?? Keyed.idle(), key, "Load"), {
		onNone: () => planned,
		onSome: (slot) => ({
			model: { ...planned.model, requests: { ...planned.model.requests, [key]: slot } },
			commands: [...planned.commands, FetchWidget({ key, endpoint, params })],
		}),
	})
}

/** Run preview: the editing state is staged, unless the query set is invalid. */
export const runPreview = (model: Model, context: PageContext): Return =>
	model.state === null || validationErrorOf(model.state) !== null
		? { model }
		: planPreview({ ...model, staged: model.state }, context)

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
			// The first read picks the source the widget was saved with.
			const opened =
				model.rawSql === null
					? openedSource(model, widget)
					: {
							sourceMode: model.sourceMode,
							initialSourceMode: model.initialSourceMode,
							sourceTabs: model.sourceTabs,
						}
			return planPreview(
				{
					...model,
					...opened,
					status: "Ready",
					document,
					timeRange: model.timeRange ?? document.timeRange,
					state: seeded,
					initial: model.initial ?? seeded,
					staged: model.staged ?? seeded,
					rawSql: model.rawSql ?? initRawSql(widget),
				},
				context,
			)
		},
	})

/** `showSourceToggle`: lists, notes and paths have no SQL rendering. */
export const showsSourceToggle = (state: EditorState): boolean => {
	const panel = toPanelType(state.visualization, state.chartId)
	return panel !== "list" && panel !== "markdown" && panel !== "paths"
}

/** The Raw SQL tab is picked and the panel type has a SQL rendering. */
export const isSqlSource = (model: Model): boolean =>
	model.sourceMode === "rawSql" && model.state !== null && showsSourceToggle(model.state)

const openedSource = (
	model: Model,
	widget: Widget,
): Pick<Model, "sourceMode" | "initialSourceMode" | "sourceTabs"> => {
	const mode = dataSourceRawSql(widget.dataSource) === null ? "builder" : "rawSql"
	return {
		sourceMode: mode,
		initialSourceMode: mode,
		sourceTabs: Tabs.init({ idBase: model.sourceTabs.idBase, values: SOURCE_MODES, selected: mode }),
	}
}

/** An edit to the editing state; a presentation edit re-plans the preview. */
export const editState = (
	model: Model,
	context: PageContext,
	edit: (state: EditorState) => EditorState,
): Return => (model.state === null ? { model } : planPreview({ ...model, state: edit(model.state) }, context))

/** `isDirty`: the source tab moved, or the state (or, in Raw SQL, the SQL) differs from what was opened. */
export const isDirty = (model: Model): boolean =>
	model.sourceMode !== model.initialSourceMode ||
	JSON.stringify(model.state) !== JSON.stringify(model.initial) ||
	(model.sourceMode === "rawSql" &&
		JSON.stringify(model.rawSql?.draft) !== JSON.stringify(model.rawSql?.initial))

export const navigate = (model: Model, url: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
})

/** `shouldBlockFn: !isSaving && isDirty()`. */
export const isBlockingNavigation = (model: Model): boolean => !model.isSaving && isDirty(model)

/** `useBlocker`: leaving with unsaved edits asks first; Discard then goes where the user was going. */
export const leave = (model: Model, url: string): Return => {
	if (!isBlockingNavigation(model)) return navigate(model, url)
	return askToLeave(model, url)
}

/** The confirmation over a held navigation (a link, Back, or Cancel). */
export const askToLeave = (model: Model, url: string): Return => {
	const next = Dialog.open(model.leaveDialog)
	return {
		model: { ...model, leaveDialog: next.model, pendingLeaveUrl: url },
		commands: Command.mapMessages(next.commands ?? [], (message) =>
			Message.GotLeaveDialogMessage({ message }),
		),
	}
}

/** The widget Apply writes: the stored widget with the edited type, source and display. */
/** `rawSql` set: the Raw SQL source, built for the type picked in the editor. */
export const editedWidget = (widget: Widget, state: EditorState, rawSql: RawSqlDraft | null): Widget => {
	const edited: Widget = {
		...widget,
		visualization: state.visualization,
		dataSource: rawSql === null ? buildDataSource(state) : rawSqlDataSourceOf(widget, rawSql, state),
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

/** The provider's window: the board's range, snapped, once the editor took focus. */
export const autocompleteWindowOf = (model: Model, context: PageContext) => {
	if (!model.isAutocompleteActive || model.timeRange === null || model.nowMs === null) return null
	const window = resolveTimeRangeWindow(model.timeRange, {
		snap: true,
		timeZone: context.timeZone,
		nowMs: model.nowMs,
	})
	return window === null ? null : { startTime: window.startTime, endTime: window.endTime }
}

/** The provider's lookups over the board's window, once active; a held key is not asked again. */
export const requestAutocomplete = (model: Model, context: PageContext): Return => {
	const range = autocompleteWindowOf(model, context)
	if (range === null) return { model }
	return AUTOCOMPLETE_LOOKUPS.reduce<Return>(
		(step, lookup) => {
			// The suggestions already asked for these names over this window: read them once.
			if (
				lookup === "productEventNames" &&
				step.model.suggestions.eventNames?.key === eventNamesKeyOf(context.orgId, range)
			)
				return step
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
