import type { DashboardDocument, TimeRange } from "@maple/domain/http"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { Option, Schema, Array as Arr, Record as Rec } from "effect"
import * as Chart from "@maple/views/charts/chart"
import * as Keyed from "@maple/views/data/keyed"
import type { PageContext } from "../../contract"
import { DEFAULT_WIDGET_WIDTH_PX, maxDataPointsForWidth, toPanelType } from "../kit/chart-registry"
import { planWidget, type WidgetGate } from "../kit/widget-data"
import { FetchVariableOptions, FetchWidget } from "./command"
import { timeRangeFromSearch, variableValuesFromSearch } from "../../../lib/dashboard-controls/search-params"
import { AsyncData } from "foldkit"
import {
	optionsByNameOf as optionsByNameFor,
	type OptionsState,
	planOptionRequests,
	planVariablesOf,
} from "../kit/variables"
import { isEditing } from "./mode"
import type { Model, WidgetSlot } from "./model"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// Which tiles fetch what: the window every tile shares, and each revealed tile's request.

type Widget = DashboardDocument["widgets"][number]

/** A viewer's own pick from the URL; an edit session works on the board's saved range instead. */
export const viewerTimeRangeOf = (model: Model): TimeRange | null =>
	isEditing(model) ? null : (timeRangeFromSearch(model.search) ?? null)

/** The range the board shows: this viewer's pick, else the board's saved range. */
export const timeRangeOf = (model: Model): TimeRange | null =>
	viewerTimeRangeOf(model) ?? model.document?.timeRange ?? null

export const isSameTimeRange = (a: TimeRange | null, b: TimeRange | null): boolean =>
	a === null || b === null
		? a === b
		: a.type === "relative"
			? b.type === "relative" && a.value === b.value
			: b.type === "absolute" && a.startTime === b.startTime && a.endTime === b.endTime

/** `resolveTimeRange`: snapped on entry, unsnapped after a reload; a bad preset falls back to 1h. */
export const windowOf = (model: Model, context: PageContext) => {
	const timeRange = timeRangeOf(model)
	if (timeRange === null || model.nowMs === null) return null
	const options = { snap: model.refreshVersion === 0, timeZone: context.timeZone, nowMs: model.nowMs }
	return (
		resolveTimeRangeWindow(timeRange, options) ??
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

/** A visible tile holding a deferred refresh until `key` answers. */
export const awaitsRefresh = (model: Model, key: string): boolean =>
	Arr.some(
		Rec.values(model.widgets),
		(slot) => slot.isStale === true && slot.isOffscreen !== true && requestKeyOf(slot.gate) === key,
	)

export const slotOf = (model: Model, widgetId: string): WidgetSlot => model.widgets[widgetId] ?? EMPTY_SLOT

/** A chart model per chart tile, kept across document updates. */
export const withCharts = (model: Model, widgets: ReadonlyArray<Widget>): Model["charts"] =>
	Rec.fromEntries(Arr.map(widgets, (widget) => [widget.id, model.charts[widget.id] ?? Chart.init()]))

type FetchCommand = ReturnType<typeof FetchWidget> | ReturnType<typeof FetchVariableOptions>

/** `optionsByName`: inline lists, fetched lists, and the loading state of the rest. */
export const optionsByNameOf = (model: Model, context: PageContext): Record<string, OptionsState> =>
	optionsByNameFor(
		context.orgId,
		shownDocumentOf(model)?.variables ?? [],
		model.variableOptions,
		windowOf(model, context),
	)

/** The board's variables as a tile plans with them: their names and resolved values. */
export const variablesOf = (model: Model, context: PageContext) =>
	planVariablesOf(
		context.orgId,
		shownDocumentOf(model)?.variables ?? [],
		variableValuesFromSearch(model.search),
		model.variableOptions,
		windowOf(model, context),
	)

/** Asks for every query variable's option list for the current window. */
const planVariableOptions = (model: Model, context: PageContext, mode: Keyed.RequestMode) => {
	const planned = planOptionRequests(
		context.orgId,
		shownDocumentOf(model)?.variables ?? [],
		model.variableOptions,
		windowOf(model, context),
		mode,
	)
	return {
		variableOptions: planned.slots,
		commands: Arr.map(planned.requests, (request) => FetchVariableOptions(request)),
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
		: encodeJson(a) === encodeJson(b)

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
		Arr.flatMap(Rec.values(state.widgets), (slot) => [
			requestKeyOf(slot.gate),
			requestKeyOf(slot.sparkGate),
		]),
	)
	return Rec.fromEntries(Arr.filter(Rec.toEntries(state.requests), ([key]) => keys.has(key)))
}

/** A stat's sparkline series, at the series' own default resolution, planned beside the stat. */
const sparklineGate = (
	context: PageContext,
	widget: Widget,
	window: ReturnType<typeof windowOf>,
	variables: ReturnType<typeof variablesOf>,
): WidgetGate | null => {
	const sparkline = widget.display.sparkline
	if (widget.visualization !== "stat" || sparkline?.enabled !== true || sparkline.dataSource === undefined)
		return null
	return planWidget({
		orgId: context.orgId,
		dataSource: sparkline.dataSource,
		window,
		...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
		variables,
	})
}

/** A tile whose last request has not answered yet: a refresh defers it rather than piling on. */
const isInFlight = (requests: Model["requests"], slot: WidgetSlot): boolean => {
	const key = requestKeyOf(slot.gate)
	const request = key === null ? undefined : requests[key]
	return request !== undefined && AsyncData.isPending(request.data)
}

type Planned = { readonly model: Model; readonly commands: ReadonlyArray<FetchCommand> }
type OptionsPlan = ReturnType<typeof planVariableOptions>

/**
 * Plans the given revealed tiles against the current window and asks for any request key not yet
 * held (`Load`) or held but stale (`Refresh`). Tiles that share a key share one fetch; off-screen
 * tiles are only marked stale and ask once they are back in view.
 */
const planTiles = (
	model: Model,
	context: PageContext,
	mode: Keyed.RequestMode,
	widgets: ReadonlyArray<Widget>,
	options: OptionsPlan,
): Planned => {
	const window = windowOf(model, context)
	const withOptions = { ...model, variableOptions: options.variableOptions }
	const variables = variablesOf(withOptions, context)
	const initial: PlanState = {
		widgets: model.widgets,
		requests: model.requests,
		commands: options.commands,
		asked: [],
	}
	const planned = Arr.reduce(widgets, initial, (state, widget) => {
		const slot = slotOf(model, widget.id)
		const keep = (kept: WidgetSlot): PlanState =>
			kept === state.widgets[widget.id]
				? state
				: { ...state, widgets: { ...state.widgets, [widget.id]: kept } }
		if (!slot.isRevealed) return keep(slot)
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
		const previousSpark = slot.sparkGate ?? null
		const nextSparkGate = sparklineGate(context, widget, window, variables)
		const sparkGate = nextSparkGate === null ? null : keptGate(nextSparkGate, previousSpark)
		const isChanged = gate !== slot.gate || sparkGate !== previousSpark
		// Still loading a window this refresh moved: wait for that answer, which re-plans the tile.
		if (mode === "Refresh" && isInFlight(state.requests, slot))
			return keep(!isChanged || slot.isStale === true ? slot : { ...slot, isStale: true })
		// Off screen: keep what it shows, and fetch the new window once it scrolls back into view.
		if (slot.isOffscreen === true)
			return keep(
				slot.isStale !== true && (isChanged || mode === "Refresh")
					? { ...slot, isStale: true }
					: slot,
			)
		const tileMode = slot.isStale === true ? "Refresh" : mode
		const asked = ask(ask(state, gate, slot.gate, tileMode), sparkGate, previousSpark, tileMode)
		const { isStale: _stale, ...fresh } = slot
		// An unchanged slot keeps its object: the tile's memo compares it by reference.
		const nextSlot = isChanged || slot.isStale === true ? { ...fresh, gate, sparkGate } : slot
		return nextSlot === state.widgets[widget.id]
			? asked
			: { ...asked, widgets: { ...asked.widgets, [widget.id]: nextSlot } }
	})
	return {
		model: { ...withOptions, widgets: planned.widgets, requests: referencedRequests(planned) },
		commands: planned.commands,
	}
}

/** Every revealed tile and the variables' option lists, for a new window, document or variable. */
export const replan = (model: Model, context: PageContext, mode: Keyed.RequestMode): Planned => {
	const document = shownDocumentOf(model)
	if (document === null) return { model, commands: [] }
	return planTiles(model, context, mode, document.widgets, planVariableOptions(model, context, mode))
}

/** One tile revealed, measured or narrowed: no other tile's plan can have moved. */
export const replanTile = (
	model: Model,
	context: PageContext,
	widgetId: string,
	mode: Keyed.RequestMode,
): Planned => {
	const widget = Arr.findFirst(
		shownDocumentOf(model)?.widgets ?? [],
		(candidate) => candidate.id === widgetId,
	)
	return widget._tag === "None"
		? { model, commands: [] }
		: planTiles(model, context, mode, [widget.value], {
				variableOptions: model.variableOptions,
				commands: [],
			})
}
