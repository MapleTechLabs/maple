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
import { variableValuesFromSearch } from "../../../lib/dashboard-controls/search-params"
import { AsyncData } from "foldkit"
import {
	optionsByNameOf as optionsByNameFor,
	type OptionsState,
	planOptionRequests,
	planVariablesOf,
} from "../kit/variables"
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

/** What the canvas draws: a previewed version's snapshot once loaded, else the live board. */
export const shownDocumentOf = (model: Model): DashboardDocument | null =>
	model.history.previewed === null
		? model.document
		: AsyncData.match(model.history.snapshot, {
				onIdle: () => null,
				onLoading: () => null,
				onFailure: () => null,
				onSuccess: (snapshot) => snapshot,
				onRefreshing: (snapshot) => snapshot,
				onStale: ({ data }) => data,
			})

const EMPTY_SLOT: WidgetSlot = { isRevealed: false, widthPx: null, gate: null }

export const slotOf = (model: Model, widgetId: string): WidgetSlot => model.widgets[widgetId] ?? EMPTY_SLOT

/** A chart model per chart tile, kept across document updates. */
export const withCharts = (model: Model, widgets: ReadonlyArray<Widget>): Model["charts"] =>
	Object.fromEntries(widgets.map((widget) => [widget.id, model.charts[widget.id] ?? Chart.init()]))

type FetchCommand = ReturnType<typeof FetchWidget> | ReturnType<typeof FetchVariableOptions>

/** `optionsByName`: inline lists, fetched lists, and the loading state of the rest. */
export const optionsByNameOf = (model: Model, context: PageContext): Record<string, OptionsState> =>
	optionsByNameFor(
		context.orgId,
		model.document?.variables ?? [],
		model.variableOptions,
		windowOf(model, context),
	)

/** The board's variables as a tile plans with them: their names and resolved values. */
export const variablesOf = (model: Model, context: PageContext) =>
	planVariablesOf(
		context.orgId,
		model.document?.variables ?? [],
		variableValuesFromSearch(model.search),
		model.variableOptions,
		windowOf(model, context),
	)

/** Asks for every query variable's option list for the current window. */
const planVariableOptions = (model: Model, context: PageContext, mode: Keyed.RequestMode) => {
	const planned = planOptionRequests(
		context.orgId,
		model.document?.variables ?? [],
		model.variableOptions,
		windowOf(model, context),
		mode,
	)
	return {
		variableOptions: planned.slots,
		commands: planned.requests.map((request) => FetchVariableOptions(request)),
	}
}

type PlanState = Readonly<{
	widgets: Model["widgets"]
	requests: Model["requests"]
	commands: ReadonlyArray<FetchCommand>
	/** Keys this pass already asked for: tiles sharing a key share the fetch. */
	asked: ReadonlyArray<string>
}>

const requestKeyOf = (gate: WidgetGate | null | undefined): string | null =>
	gate?._tag === "Request" ? gate.request.key : null

/** Same request key, or the same non-request gate: the tile reads nothing new from it. */
const isSameGate = (a: WidgetGate, b: WidgetGate): boolean =>
	a._tag === "Request" || b._tag === "Request"
		? requestKeyOf(a) !== null && requestKeyOf(a) === requestKeyOf(b)
		: JSON.stringify(a) === JSON.stringify(b)

/** The previous gate while it still says the same thing, so memoized tiles see the same object. */
const keptGate = (next: WidgetGate, previous: WidgetGate | null | undefined): WidgetGate =>
	previous !== undefined && previous !== null && isSameGate(next, previous) ? previous : next

/** The previous key whose data may stand in for a new one: only when just the window moved. */
const carriedKeyOf = (
	gate: Extract<WidgetGate, { _tag: "Request" }>,
	previous: WidgetGate | null | undefined,
) =>
	previous?._tag === "Request" && previous.request.shape === gate.request.shape
		? previous.request.key
		: null

/**
 * Asks for a gate's request unless this pass already did, or the key is held and fresh. A new key
 * for the same query over a new window starts from the tile's previous key, so its data shows as
 * refreshing; a different query starts loading.
 */
const ask = (
	state: PlanState,
	gate: WidgetGate | null,
	previous: WidgetGate | null | undefined,
	mode: Keyed.RequestMode,
): PlanState => {
	if (gate === null || gate._tag !== "Request") return state
	const { key, endpoint, params } = gate.request
	if (state.asked.includes(key)) return state
	const previousKey = carriedKeyOf(gate, previous)
	const seed =
		state.requests[key] ??
		(previousKey === null ? undefined : state.requests[previousKey]) ??
		Keyed.idle()
	return Option.match(Keyed.request(seed, key, mode), {
		onNone: () => state,
		onSome: (next) => ({
			...state,
			requests: { ...state.requests, [key]: next },
			commands: [...state.commands, FetchWidget({ key, endpoint, params })],
			asked: [...state.asked, key],
		}),
	})
}

/** Drops request slots no tile's current gate points at, so refreshes do not grow the map. */
const referencedRequests = (state: PlanState): Model["requests"] => {
	const keys = new Set(
		Object.values(state.widgets).flatMap((slot) => [
			requestKeyOf(slot.gate),
			requestKeyOf(slot.sparkGate),
		]),
	)
	return Object.fromEntries(Object.entries(state.requests).filter(([key]) => keys.has(key)))
}

/**
 * `StatSparklineLoader` mounts inside the stat's ready frame, so its series is asked for only once
 * the stat itself has data, at the series' own default resolution. While the stat is loading again
 * the previous series gate is kept, so its data survives pruning until replaced or disabled.
 */
const sparklineGate = (
	context: PageContext,
	widget: Widget,
	window: ReturnType<typeof windowOf>,
	requests: Model["requests"],
	gate: WidgetGate,
	previous: WidgetGate | null | undefined,
	variables: ReturnType<typeof variablesOf>,
): WidgetGate | null => {
	const sparkline = widget.display.sparkline
	if (widget.visualization !== "stat" || sparkline?.enabled !== true || sparkline.dataSource === undefined)
		return null
	const state = dataStateOf(requests, widget, gate)._tag
	if (state === "Loading") return previous ?? null
	if (state !== "Ready") return null
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
	const document = shownDocumentOf(model)
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
		const planned = planWidget({
			orgId: context.orgId,
			dataSource: widget.dataSource,
			window,
			...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
			maxDataPoints: maxDataPointsForWidth(slot.widthPx ?? DEFAULT_WIDGET_WIDTH_PX, panelType),
			variables,
			isNarrowed: slot.isNarrowed === true,
		})
		const gate = keptGate(planned, slot.gate)
		// The stat is asked for first, so its refreshing data gates the sparkline on the new key.
		const asked = ask(state, gate, slot.gate, mode)
		const nextSparkGate = sparklineGate(
			context,
			widget,
			window,
			asked.requests,
			gate,
			slot.sparkGate,
			variables,
		)
		const sparkGate = nextSparkGate === null ? null : keptGate(nextSparkGate, slot.sparkGate)
		const kept = sparkGate !== null && sparkGate === slot.sparkGate
		// An unchanged slot keeps its object: the tile's memo compares it by reference.
		const nextSlot =
			gate === slot.gate && sparkGate === (slot.sparkGate ?? null) ? slot : { ...slot, gate, sparkGate }
		const widgets =
			nextSlot === state.widgets[widget.id]
				? asked.widgets
				: { ...asked.widgets, [widget.id]: nextSlot }
		return kept ? { ...asked, widgets } : ask({ ...asked, widgets }, sparkGate, slot.sparkGate, mode)
	}, initial)
	return {
		model: { ...withOptions, widgets: planned.widgets, requests: referencedRequests(planned) },
		commands: planned.commands,
	}
}
