import type { DashboardDocument } from "@maple/domain/http"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { Option } from "effect"
import * as Chart from "../../../charts/chart"
import * as Keyed from "../../../data/keyed"
import type { PageContext } from "../../contract"
import { DEFAULT_WIDGET_WIDTH_PX, maxDataPointsForWidth, toPanelType } from "../kit/chart-registry"
import { dataStateOf } from "../kit/data-state"
import { planWidget, type WidgetGate } from "../kit/widget-data"
import { FetchVariableOptions, FetchWidget } from "./command"
import { variableValuesFromSearch } from "@maple/web/lib/dashboard-controls/search-params"
import { AsyncData } from "foldkit"
import { type OptionsState, optionsSourceOf, resolveVariableValues } from "../kit/variables"
import type { Model, WidgetSlot } from "./model"

// Which tiles fetch what: the window every tile shares, and each revealed tile's request.

type Widget = DashboardDocument["widgets"][number]

/** `resolveTimeRange`: snapped on entry, unsnapped after a reload; a bad preset falls back to 1h. */
export const windowOf = (model: Model, context: PageContext) => {
	if (model.timeRange === null || model.nowMs === null) return null
	const options = { snap: model.refreshVersion === 0, timeZone: context.timeZone, nowMs: model.nowMs }
	return (
		resolveTimeRangeWindow(model.timeRange, options) ??
		resolveTimeRangeWindow({ type: "relative", value: "1h" }, options)
	)
}

const EMPTY_SLOT: WidgetSlot = { isRevealed: false, widthPx: null, gate: null }

export const slotOf = (model: Model, widgetId: string): WidgetSlot => model.widgets[widgetId] ?? EMPTY_SLOT

/** A chart model per chart tile, kept across document updates. */
export const withCharts = (model: Model, widgets: ReadonlyArray<Widget>): Model["charts"] =>
	Object.fromEntries(widgets.map((widget) => [widget.id, model.charts[widget.id] ?? Chart.init()]))

type FetchCommand = ReturnType<typeof FetchWidget> | ReturnType<typeof FetchVariableOptions>

/** `optionsByName`: inline lists, fetched lists, and the loading state of the rest. */
export const optionsByNameOf = (model: Model, context: PageContext): Record<string, OptionsState> => {
	const window = windowOf(model, context)
	return Object.fromEntries(
		(model.document?.variables ?? []).map((variable) => {
			const source = optionsSourceOf(context.orgId, variable, window)
			if (source._tag === "Inline") return [variable.name, { options: source.options, loading: false }]
			if (source._tag === "None")
				return [variable.name, { options: [], loading: variable.type === "query" }]
			const slot = model.variableOptions[variable.name]
			const data = slot === undefined || slot.key !== source.key ? AsyncData.Idle() : slot.data
			return [
				variable.name,
				AsyncData.match(data, {
					onIdle: () => ({ options: [], loading: true }),
					onLoading: () => ({ options: [], loading: true }),
					onFailure: () => ({ options: [], loading: false }),
					onSuccess: (options) => ({ options, loading: false }),
					onRefreshing: (options) => ({ options, loading: true }),
					onStale: ({ data: options }) => ({ options, loading: false }),
				}),
			]
		}),
	)
}

/** The board's variables as a tile plans with them: their names and resolved values. */
export const variablesOf = (model: Model, context: PageContext) => {
	const variables = model.document?.variables ?? []
	return {
		names: variables.map((variable) => variable.name),
		values: resolveVariableValues(
			variables,
			variableValuesFromSearch(model.search),
			optionsByNameOf(model, context),
		),
	}
}

/** Asks for every query variable's option list for the current window. */
const planVariableOptions = (model: Model, context: PageContext, mode: Keyed.RequestMode) => {
	const window = windowOf(model, context)
	return (model.document?.variables ?? []).reduce(
		(state, variable) => {
			const source = optionsSourceOf(context.orgId, variable, window)
			if (source._tag !== "Query" || window === null) return state
			const slot = state.variableOptions[variable.name] ?? Keyed.idle()
			return Option.match(Keyed.request(slot, source.key, mode), {
				onNone: () => state,
				onSome: (next) => ({
					variableOptions: { ...state.variableOptions, [variable.name]: next },
					commands: [
						...state.commands,
						FetchVariableOptions({ name: variable.name, key: source.key, variable, window }),
					],
				}),
			})
		},
		{ variableOptions: model.variableOptions, commands: [] as ReadonlyArray<FetchCommand> },
	)
}

type PlanState = Readonly<{
	widgets: Model["widgets"]
	requests: Model["requests"]
	commands: ReadonlyArray<FetchCommand>
	/** Keys this pass already asked for: tiles sharing a key share the fetch. */
	asked: ReadonlyArray<string>
}>

/** Asks for a gate's request unless this pass already did, or the key is held and fresh. */
const ask = (state: PlanState, gate: WidgetGate, mode: Keyed.RequestMode): PlanState => {
	if (gate._tag !== "Request") return state
	const { key, endpoint, params } = gate.request
	if (state.asked.includes(key)) return state
	return Option.match(Keyed.request(state.requests[key] ?? Keyed.idle(), key, mode), {
		onNone: () => state,
		onSome: (next) => ({
			...state,
			requests: { ...state.requests, [key]: next },
			commands: [...state.commands, FetchWidget({ key, endpoint, params })],
			asked: [...state.asked, key],
		}),
	})
}

/**
 * `StatSparklineLoader` mounts inside the stat's ready frame, so its series is asked for only once
 * the stat itself has data, at the series' own default resolution.
 */
const sparklineGate = (
	context: PageContext,
	widget: Widget,
	window: ReturnType<typeof windowOf>,
	requests: Model["requests"],
	gate: WidgetGate,
	variables: ReturnType<typeof variablesOf>,
): WidgetGate | null => {
	const sparkline = widget.display.sparkline
	if (widget.visualization !== "stat" || sparkline?.enabled !== true || sparkline.dataSource === undefined)
		return null
	if (dataStateOf(requests, widget, gate)._tag !== "Ready") return null
	return planWidget({
		orgId: context.orgId,
		dataSource: sparkline.dataSource,
		window,
		...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
		variables,
	})
}

/**
 * Plans every revealed tile against the current window and asks for any request key not yet
 * held (`Load`) or held but stale (`Refresh`). Tiles that share a key share one fetch.
 */
export const replan = (
	model: Model,
	context: PageContext,
	mode: Keyed.RequestMode,
): { readonly model: Model; readonly commands: ReadonlyArray<FetchCommand> } => {
	const document = model.document
	if (document === null) return { model, commands: [] }
	const window = windowOf(model, context)
	const options = planVariableOptions(model, context, mode)
	const withOptions = { ...model, variableOptions: options.variableOptions }
	const variables = variablesOf(withOptions, context)
	const initial: PlanState = {
		widgets: model.widgets,
		requests: model.requests,
		commands: options.commands,
		asked: [],
	}
	const planned = document.widgets.reduce((state, widget) => {
		const slot = slotOf(model, widget.id)
		if (!slot.isRevealed) return { ...state, widgets: { ...state.widgets, [widget.id]: slot } }
		const panelType = toPanelType(widget.visualization, widget.display.chartId)
		const gate = planWidget({
			orgId: context.orgId,
			dataSource: widget.dataSource,
			window,
			...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
			maxDataPoints: maxDataPointsForWidth(slot.widthPx ?? DEFAULT_WIDGET_WIDTH_PX, panelType),
			variables,
		})
		const sparkGate = sparklineGate(context, widget, window, state.requests, gate, variables)
		const widgets = { ...state.widgets, [widget.id]: { ...slot, gate, sparkGate } }
		return [gate, sparkGate].reduce(
			(acc, next) => (next === null ? acc : ask(acc, next, mode)),
			{ ...state, widgets },
		)
	}, initial)
	return {
		model: { ...withOptions, widgets: planned.widgets, requests: planned.requests },
		commands: planned.commands,
	}
}
