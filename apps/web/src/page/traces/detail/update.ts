import { snapTimestamp } from "@maple/web-data/lib/time-range"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as TraceFlow from "../../../service-map/trace-flow/trace-flow"
import * as Dialog from "../../../ui/dialog"
import * as Resizable from "../../../ui/resizable"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { copyToast } from "../../kit/clipboard"
import {
	CopyTraceId,
	correlationWindow,
	decodeTraceId,
	FetchHierarchy,
	spanHierarchyKey,
	FetchLogsCount,
	FetchProductEvents,
	FetchReplays,
	FetchSpanEvents,
	ReadClock,
	ReadListQuery,
} from "./command"
import { withListQuery } from "./list-query"
import { Message, type TraceView } from "./message"
import type { Model } from "./model"
import { type LoadedTrace, loadedTrace, selectedSpanOf } from "./select"
import * as SpanPanel from "./span-panel"
import { splitLayout } from "./split"
import * as Timeline from "./timeline"
import { toSpanNode } from "./trace-data"
import * as Waterfall from "./waterfall"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>
type Route = { readonly traceId: string; readonly search: Model["search"] }

/** `DEFAULT_COLOR_BY` (packages/ui/src/components/traces/color-by.ts). */
const DEFAULT_COLOR_BY = "service"

export const viewOf = (model: Model): TraceView => model.search.view ?? "timeline"

const lift =
	<A>(wrap: (inner: A) => Message) =>
	(commands: ReadonlyArray<Command.Command<A, never, Resources>> | undefined): ReadonlyArray<Cmd> =>
		Command.mapMessages(commands ?? [], wrap)

const liftTimeline = lift((message: Timeline.Message) => Message.GotTimelineMessage({ message }))
const liftWaterfall = lift((message: Waterfall.Message) => Message.GotWaterfallMessage({ message }))
const liftPanel = lift((message: SpanPanel.Message) => Message.GotSpanPanelMessage({ message }))

const navigate = (model: Model, search: Model["search"]): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: withListQuery(hrefOf(AppRoute.Trace({ traceId: model.traceId, search })), model.listQuery),
		isReplace: true,
	}),
})

/** The mobile span sheet's state, derived from the selection (`open={selectedSpan != null}`). */
export const spanSheetOf = (model: Model): Dialog.Model =>
	Dialog.init("trace-span-sheet", "sheet", { isOpen: model.spanPanel !== null })

/** `handleCloseSpanDetails`: `spanId` leaves the URL, replacing history. */
const closeSpanPanel = (model: Model): Return =>
	model.search.spanId === undefined ? { model } : navigate(model, { ...model.search, spanId: undefined })

/** `handleSelectSpan`: re-selecting the selected span is a no-op. */
const selectSpan = (model: Model, spanId: string): Return =>
	model.search.spanId === spanId ? { model } : navigate(model, { ...model.search, spanId })

const spanEventsData = (model: Model) => Option.getOrNull(AsyncData.getData(model.spanEvents.data))

/** Base UI mounts only the active tab's panel: build its Submodel, drop the others. */
const enterTab = (model: Model, trace: LoadedTrace, view: TraceView): Return => {
	const selectedSpanId = selectedSpanOf(model)?.spanId ?? null
	const cleared: Model = { ...model, timeline: null, waterfall: null, flow: null }
	if (view === "timeline") {
		const next = Timeline.init({
			trace: trace.data,
			traceStartTime: trace.traceStartTime,
			selectedSpanId,
			colorBy: model.colorBy,
			spanEvents: spanEventsData(model),
		})
		return { model: { ...cleared, timeline: next.model }, commands: liftTimeline(next.commands) }
	}
	if (view === "waterfall") {
		const next = Waterfall.init({
			trace: trace.data,
			traceStartTime: trace.traceStartTime,
			selectedSpanId,
		})
		return { model: { ...cleared, waterfall: next.model }, commands: liftWaterfall(next.commands) }
	}
	const graph = TraceFlow.buildFlowGraph({
		rootSpans: trace.data.rootSpans.map(toSpanNode),
		totalDurationMs: trace.data.totalDurationMs,
		services: [...new Set(trace.data.spans.map((span) => span.serviceName))],
	})
	const flowModel = { ...TraceFlow.init(), selectedSpanId: Option.fromNullishOr(selectedSpanId) }
	return { model: { ...cleared, flow: { graph, model: flowModel } } }
}

/** The span panel follows the URL's `spanId`; a new selection mounts a new panel. */
const syncPanel = (model: Model, context: PageContext, trace: LoadedTrace): Return => {
	const span = selectedSpanOf(model)
	if (span === undefined)
		return {
			model: {
				...model,
				spanPanel: null,
				split: withLayout(model.split, splitLayout(1, model.splitWidth)),
			},
		}
	const next = SpanPanel.init({
		span,
		traceId: model.traceId,
		traceStartTime: trace.traceStartTime,
		totalDurationMs: trace.data.totalDurationMs,
		orgId: context.orgId,
	})
	return {
		model: {
			...model,
			spanPanel: next.model,
			split: withLayout(model.split, splitLayout(2, model.splitWidth)),
		},
		commands: liftPanel(next.commands),
	}
}

/** A panel joining or leaving the group lays it out from the panels' `defaultSize`s again. */
const withLayout = (split: Resizable.Model, layout: ReadonlyArray<number>): Resizable.Model =>
	split.layout.length === layout.length ? split : { ...split, layout }

export const TAB_VALUES: ReadonlyArray<TraceView> = ["waterfall", "timeline", "flow"]

type Step = Readonly<{ patch: Partial<Model>; command: Cmd }>

/** One `Keyed.request`: a step when the slot needs the fetch, nothing otherwise. */
const step = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: () => Cmd,
): ReadonlyArray<Step> =>
	Option.match(Keyed.request(slot, key, "Load"), {
		onNone: () => [],
		onSome: (next) => [{ patch: write(next), command: fetch() }],
	})

const chain = (first: Return, then: (model: Model) => Return): Return => {
	const second = then(first.model)
	return {
		model: second.model,
		commands: [...(first.commands ?? []), ...(second.commands ?? [])],
		outMessage: second.outMessage ?? first.outMessage,
	}
}

/** The header links, timeline events and product events read the loaded trace. */
const followTrace = (model: Model, context: PageContext, trace: LoadedTrace): Return => {
	const traceId = trace.data.traceId
	const org = context.orgId
	const window = correlationWindow(trace.traceStartTime, trace.data.totalDurationMs)
	const eventsInput = {
		traceId,
		traceStartTime: trace.traceStartTime,
		totalDurationMs: trace.data.totalDurationMs,
	}
	const eventsKey = requestKey(org, "getTraceSpanEvents", { data: eventsInput })
	const replaysKey = requestKey(org, "getReplaysForTrace", { data: { traceId } })
	const windowed = Option.match(window, {
		onNone: (): ReadonlyArray<Step> => [],
		onSome: ({ startTime, endTime }) => {
			// The atom decodes its 15 s-snapped key back into the request (S6).
			const input = { traceId, startTime: snapTimestamp(startTime), endTime: snapTimestamp(endTime) }
			const logsKey = requestKey(org, "getLogsCount", { data: input })
			const listKey = requestKey(org, "productEventsForTrace", { data: input })
			return [
				...step(
					model.logsCount,
					logsKey,
					(logsCount) => ({ logsCount }),
					() => FetchLogsCount({ key: logsKey, ...input }),
				),
				...(model.isPeek
					? []
					: step(
							model.productEvents,
							listKey,
							(productEvents) => ({ productEvents }),
							() => FetchProductEvents({ key: listKey, ...input }),
						)),
			]
		},
	})
	const steps: ReadonlyArray<Step> = [
		...(model.isPeek
			? []
			: step(
					model.spanEvents,
					eventsKey,
					(spanEvents) => ({ spanEvents }),
					() => FetchSpanEvents({ key: eventsKey, ...eventsInput }),
				)),
		...step(
			model.replaySessionId,
			replaysKey,
			(replaySessionId) => ({ replaySessionId }),
			() => FetchReplays({ key: replaysKey, traceId }),
		),
		...windowed,
	]
	return {
		model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
		commands: steps.map((step) => step.command),
	}
}

const requestHierarchy = (model: Model, context: PageContext): Return =>
	Option.match(decodeTraceId(model.traceId), {
		onNone: () => ({ model }),
		onSome: (traceId) => {
			const key = spanHierarchyKey(context.orgId, traceId, model.search.t)
			return Option.match(Keyed.request(model.hierarchy, key, "Load"), {
				onNone: () => ({ model }),
				onSome: (hierarchy) => ({
					model: { ...model, hierarchy },
					commands: [FetchHierarchy({ key, traceId, timestamp: model.search.t })],
				}),
			})
		},
	})

/** Everything that hangs off a loaded trace: follow-up fetches, the active tab, the span panel. */
const onLoaded = (model: Model, context: PageContext): Return =>
	Option.match(loadedTrace(model), {
		onNone: () => ({ model }),
		onSome: (trace) =>
			trace.rootSpan === undefined
				? { model }
				: chain(
						chain(followTrace(model, context, trace), (next) =>
							enterTab(next, trace, viewOf(next)),
						),
						(next) => syncPanel(next, context, trace),
					),
	})

// ENTRY POINTS

export const init = (route: Route, context: PageContext, isPeek = false): Return => {
	const model: Model = {
		traceId: route.traceId,
		search: route.search,
		nowMs: 0,
		listQuery: "",
		hierarchy: Keyed.idle(),
		spanEvents: Keyed.idle(),
		productEvents: Keyed.idle(),
		logsCount: Keyed.idle(),
		replaySessionId: Keyed.idle(),
		colorBy: DEFAULT_COLOR_BY,
		tabs: Tabs.init({ idBase: 23, values: TAB_VALUES, selected: route.search.view ?? "timeline" }),
		split: isPeek
			? Resizable.init("trace-peek-split", "vertical", [100])
			: Resizable.init("trace-split", "horizontal", [100]),
		splitWidth: null,
		timeline: null,
		waterfall: null,
		flow: null,
		spanPanel: null,
		isPeek,
	}
	const requested = requestHierarchy(model, context)
	const reads = isPeek ? [ReadClock()] : [ReadClock(), ReadListQuery()]
	return { model: requested.model, commands: [...reads, ...(requested.commands ?? [])] }
}

/** A search change: a new `t` re-keys the hierarchy, a new view swaps the tab, a new span the panel. */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	const previous = model.search
	const next: Model = {
		...model,
		search: route.search,
		tabs: { ...model.tabs, selected: route.search.view ?? "timeline" },
	}
	if (previous.t !== route.search.t)
		return chain(requestHierarchy(next, context), (m) => onLoaded(m, context))
	return Option.match(loadedTrace(next), {
		onNone: () => ({ model: next }),
		onSome: (trace) => {
			if (trace.rootSpan === undefined) return { model: next }
			const tabbed =
				(previous.view ?? "timeline") !== viewOf(next)
					? enterTab(next, trace, viewOf(next))
					: previous.spanId !== route.search.spanId
						? selectInTab(next)
						: { model: next }
			return previous.spanId === route.search.spanId
				? tabbed
				: chain(tabbed, (m) => syncPanel(m, context, trace))
		},
	})
}

export const contextChanged = (model: Model): Return => ({ model })

/** The selection changed under an open tab: the tab follows the new `selectedSpanId`. */
const selectInTab = (model: Model): Return => {
	const spanId = selectedSpanOf(model)?.spanId ?? null
	if (model.timeline !== null) {
		const next = Timeline.setSelectedSpanId(model.timeline, spanId)
		return { model: { ...model, timeline: next.model }, commands: liftTimeline(next.commands) }
	}
	if (model.waterfall !== null) {
		const next = Waterfall.setSelectedSpanId(model.waterfall, spanId)
		return { model: { ...model, waterfall: next.model }, commands: liftWaterfall(next.commands) }
	}
	return model.flow === null
		? { model }
		: {
				model: {
					...model,
					flow: {
						...model.flow,
						model: { ...model.flow.model, selectedSpanId: Option.fromNullishOr(spanId) },
					},
				},
			}
}

const withSlot = <K extends "spanEvents" | "productEvents" | "logsCount" | "replaySessionId">(
	model: Model,
	slot: K,
	next: Model[K],
): Model => ({ ...model, [slot]: next })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadListQuery: ({ listQuery }) => ({ model: { ...model, listQuery } }),
		PressedPageEscape: () => closeSpanPanel(model),
		GotSpanSheetMessage: ({ message: inner }) =>
			Dialog.update(spanSheetOf(model), inner).outMessage?._tag === "Closed"
				? closeSpanPanel(model)
				: { model },
		CompletedFetchHierarchy: ({ key, result }) => {
			const hierarchy = Keyed.accept(model.hierarchy, key, result)
			return hierarchy === model.hierarchy ? { model } : onLoaded({ ...model, hierarchy }, context)
		},
		ClickedRetryHierarchy: () => requestHierarchy(model, context),
		CompletedFetchSpanEvents: ({ key, result }) => {
			const spanEvents = Keyed.accept(model.spanEvents, key, result)
			const next = withSlot(model, "spanEvents", spanEvents)
			const events = Option.getOrNull(AsyncData.getData(spanEvents.data))
			if (next.timeline === null || events === null || spanEvents === model.spanEvents)
				return { model: next }
			const timeline = Timeline.setSpanEvents(next.timeline, events)
			return { model: { ...next, timeline: timeline.model }, commands: liftTimeline(timeline.commands) }
		},
		CompletedFetchProductEvents: ({ key, result }) => ({
			model: withSlot(model, "productEvents", Keyed.accept(model.productEvents, key, result)),
		}),
		CompletedFetchLogsCount: ({ key, result }) => ({
			model: withSlot(model, "logsCount", Keyed.accept(model.logsCount, key, result)),
		}),
		CompletedFetchReplays: ({ key, result }) => ({
			model: withSlot(model, "replaySessionId", Keyed.accept(model.replaySessionId, key, result)),
		}),
		ClickedCopyTraceId: () => ({ model, commands: [CopyTraceId({ traceId: model.traceId })] }),
		CompletedCopyTraceId: ({ isOk }) => ({ model, outMessage: copyToast("trace ID", isOk) }),
		GotTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.tabs, inner)
			const lifted: Return = {
				model: { ...model, tabs: next.model },
				commands: lift((m: Tabs.Message) => Message.GotTabsMessage({ message: m }))(next.commands),
			}
			const view = TAB_VALUES.find((value) => value === next.model.selected)
			return view === undefined || view === viewOf(model)
				? lifted
				: chain(lifted, (m) => navigate(m, { ...m.search, view }))
		},
		// A layout made before the first measurement is redone once the width is known.
		MeasuredSplitWidth: ({ width }) => {
			const isFallback = model.splitWidth === null && model.split.layout.length === 2
			return {
				model: {
					...model,
					splitWidth: width,
					split: isFallback ? { ...model.split, layout: splitLayout(2, width) } : model.split,
				},
			}
		},
		GotSplitMessage: ({ message: inner }) => {
			const next = Resizable.update(model.split, inner)
			return {
				model: { ...model, split: next.model },
				commands: lift((m: Resizable.Message) => Message.GotSplitMessage({ message: m }))(
					next.commands,
				),
			}
		},
		ClickedViewOriginSpan: ({ spanId }) => selectSpan(model, spanId),
		ClickedProductEvent: ({ spanId }) => selectSpan(model, spanId),
		GotTimelineMessage: ({ message: inner }) => {
			if (model.timeline === null) return { model }
			const next = Timeline.update(model.timeline, inner)
			const lifted: Return = {
				model: { ...model, timeline: next.model },
				commands: liftTimeline(next.commands),
			}
			const out = next.outMessage
			if (out === undefined) return lifted
			if (out._tag === "SelectedSpan") return chain(lifted, (m) => selectSpan(m, out.spanId))
			return chain(lifted, (m) => {
				if (m.timeline === null) return { model: m }
				const recolored = Timeline.setColorBy(m.timeline, out.colorBy)
				return {
					model: { ...m, colorBy: out.colorBy, timeline: recolored.model },
					commands: liftTimeline(recolored.commands),
				}
			})
		},
		GotWaterfallMessage: ({ message: inner }) => {
			if (model.waterfall === null) return { model }
			const next = Waterfall.update(model.waterfall, inner)
			const lifted: Return = {
				model: { ...model, waterfall: next.model },
				commands: liftWaterfall(next.commands),
			}
			const out = next.outMessage
			return out === undefined ? lifted : chain(lifted, (m) => selectSpan(m, out.spanId))
		},
		GotFlowMessage: ({ message: inner }) => {
			if (model.flow === null) return { model }
			const flowModel = TraceFlow.update(model.flow.graph)(model.flow.model, inner)
			const next: Model = { ...model, flow: { ...model.flow, model: flowModel } }
			const picked = Option.getOrUndefined(flowModel.selectedSpanId)
			return inner._tag === "ClickedSpanNode" && picked !== undefined
				? selectSpan(next, picked)
				: { model: next }
		},
		GotSpanPanelMessage: ({ message: inner }) => {
			if (model.spanPanel === null) return { model }
			const next = SpanPanel.update(model.spanPanel, inner)
			const lifted: Return = {
				model: { ...model, spanPanel: next.model },
				commands: liftPanel(next.commands),
			}
			const out = next.outMessage
			if (out === undefined) return lifted
			if (out._tag === "Closed") return chain(lifted, closeSpanPanel)
			if (out._tag === "SelectedSpanId") return chain(lifted, (m) => selectSpan(m, out.spanId))
			return {
				...lifted,
				outMessage: PageOutMessage.RequestedNavigation({ url: out.url, isReplace: false }),
			}
		},
	})
