import type { DashboardDocument } from "@maple/domain/http"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { Option } from "effect"
import * as Chart from "../../../charts/chart"
import * as Keyed from "../../../data/keyed"
import type { PageContext } from "../../contract"
import { DEFAULT_WIDGET_WIDTH_PX, maxDataPointsForWidth, toPanelType } from "../kit/chart-registry"
import { dataStateOf } from "../kit/data-state"
import { planWidget, type WidgetGate } from "../kit/widget-data"
import { FetchWidget } from "./command"
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

type FetchCommand = ReturnType<typeof FetchWidget>

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
	const initial: PlanState = { widgets: model.widgets, requests: model.requests, commands: [], asked: [] }
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
		})
		const sparkGate = sparklineGate(context, widget, window, state.requests, gate)
		const widgets = { ...state.widgets, [widget.id]: { ...slot, gate, sparkGate } }
		return [gate, sparkGate].reduce(
			(acc, next) => (next === null ? acc : ask(acc, next, mode)),
			{ ...state, widgets },
		)
	}, initial)
	return {
		model: { ...model, widgets: planned.widgets, requests: planned.requests },
		commands: planned.commands,
	}
}
