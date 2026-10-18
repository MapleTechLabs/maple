import type { DashboardDocument } from "@maple/domain/http"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { Option } from "effect"
import * as Chart from "../../../charts/chart"
import * as Keyed from "../../../data/keyed"
import type { PageContext } from "../../contract"
import { DEFAULT_WIDGET_WIDTH_PX, maxDataPointsForWidth, toPanelType } from "../kit/chart-registry"
import { planWidget } from "../kit/widget-data"
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
	const initial = {
		widgets: model.widgets,
		requests: model.requests,
		commands: [] as ReadonlyArray<FetchCommand>,
		/** Keys this pass already asked for: tiles sharing a key share the fetch. */
		asked: [] as ReadonlyArray<string>,
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
		})
		const widgets = { ...state.widgets, [widget.id]: { ...slot, gate } }
		if (gate._tag !== "Request") return { ...state, widgets }
		const { key, endpoint, params } = gate.request
		if (state.asked.includes(key)) return { ...state, widgets }
		return Option.match(Keyed.request(state.requests[key] ?? Keyed.idle(), key, mode), {
			onNone: () => ({ ...state, widgets }),
			onSome: (next) => ({
				widgets,
				requests: { ...state.requests, [key]: next },
				commands: [...state.commands, FetchWidget({ key, endpoint, params })],
				asked: [...state.asked, key],
			}),
		})
	}, initial)
	return {
		model: { ...model, widgets: planned.widgets, requests: planned.requests },
		commands: planned.commands,
	}
}
