import { Option } from "effect"
import { Command, type Update } from "foldkit"
import * as SpanPanel from "../../page/traces/detail/span-panel"
import { findSpan } from "../../page/traces/detail/select"
import * as Timeline from "../../page/traces/detail/timeline"
import type { TraceData } from "../../page/traces/detail/trace-data"
import * as Waterfall from "../../page/traces/detail/waterfall"
import * as TraceFlow from "../../service-map/trace-flow/trace-flow"
import * as Tabs from "../../ui/tabs"
import type { Resources } from "../../platform/resources"
import { LAB_FLOW_GRAPH, LAB_MARKERS, LAB_TRACE, Message, type Model, TAB_VALUES } from "./model"

type Return = Update.Return<Model, Message, Resources>

const liftTimeline = (step: Timeline.UpdateReturn, model: Model): Return => ({
	model: { ...model, timeline: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotTimelineMessage({ message })),
})

const liftWaterfall = (step: Waterfall.UpdateReturn, model: Model): Return => ({
	model: { ...model, waterfall: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotWaterfallMessage({ message })),
})

/** Base UI mounts only the active tab's panel: build its Submodel, drop the others. */
const enterTab = (model: Model, trace: TraceData, view: string): Return => {
	const cleared: Model = { ...model, timeline: null, waterfall: null, flow: null }
	const traceStartTime = trace.traceStartTime ?? ""
	if (view === "timeline")
		return liftTimeline(
			Timeline.init({
				trace,
				traceStartTime,
				selectedSpanId: model.selectedSpanId,
				colorBy: model.colorBy,
				spanEvents: LAB_MARKERS,
			}),
			cleared,
		)
	if (view === "waterfall")
		return liftWaterfall(
			Waterfall.init({ trace, traceStartTime, selectedSpanId: model.selectedSpanId }),
			cleared,
		)
	return {
		model: {
			...cleared,
			flow: { ...TraceFlow.init(), selectedSpanId: Option.fromNullishOr(model.selectedSpanId) },
		},
	}
}

export const init = (): Return => {
	const model: Model = {
		tabs: Tabs.init({ idBase: 23, values: TAB_VALUES, selected: "timeline" }),
		colorBy: "service",
		selectedSpanId: null,
		timeline: null,
		waterfall: null,
		flow: null,
		panel: null,
	}
	return Option.match(LAB_TRACE, {
		onNone: () => ({ model }),
		onSome: (trace) => enterTab(model, trace, "timeline"),
	})
}

/** `setSelected`: the open tab re-renders with the span, and its events list starts closed. */
const selectSpan = (model: Model, spanId: string): Return => {
	if (model.selectedSpanId === spanId) return { model }
	const span = Option.flatMap(LAB_TRACE, (trace) => Option.fromNullishOr(findSpan(trace.rootSpans, spanId)))
	const panel = Option.match(Option.all([LAB_TRACE, span]), {
		onNone: () => null,
		// The panel's own reads (detail, logs) are not sent: the lab has no backend.
		onSome: ([trace, found]) =>
			SpanPanel.init({
				span: found,
				traceId: trace.traceId,
				traceStartTime: trace.traceStartTime ?? "",
				totalDurationMs: trace.totalDurationMs,
				orgId: "",
			}).model,
	})
	const next: Model = { ...model, selectedSpanId: spanId, panel }
	if (next.timeline !== null) return liftTimeline(Timeline.setSelectedSpanId(next.timeline, spanId), next)
	if (next.waterfall !== null)
		return liftWaterfall(Waterfall.setSelectedSpanId(next.waterfall, spanId), next)
	return next.flow === null
		? { model: next }
		: { model: { ...next, flow: { ...next.flow, selectedSpanId: Option.some(spanId) } } }
}

const chain = (first: Return, then: (model: Model) => Return): Return => {
	const second = then(first.model)
	return { model: second.model, commands: [...(first.commands ?? []), ...(second.commands ?? [])] }
}

const updateFlow = (model: Model, message: TraceFlow.Message): Return =>
	Option.match(LAB_FLOW_GRAPH, {
		onNone: () => ({ model }),
		onSome: (graph) => {
			if (model.flow === null) return { model }
			const flow = TraceFlow.update(graph)(model.flow, message)
			const picked = Option.getOrUndefined(flow.selectedSpanId)
			const next: Model = { ...model, flow }
			return message._tag === "ClickedSpanNode" && picked !== undefined
				? selectSpan(next, picked)
				: { model: next }
		},
	})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.tabs, inner)
			const lifted: Return = {
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotTabsMessage({ message: child }),
				),
			}
			return next.model.selected === model.tabs.selected
				? lifted
				: Option.match(LAB_TRACE, {
						onNone: () => lifted,
						onSome: (trace) => chain(lifted, (m) => enterTab(m, trace, next.model.selected)),
					})
		},
		GotTimelineMessage: ({ message: inner }) => {
			if (model.timeline === null) return { model }
			const next = Timeline.update(model.timeline, inner)
			const lifted = liftTimeline(next, model)
			const out = next.outMessage
			if (out === undefined) return lifted
			if (out._tag === "SelectedSpan") return chain(lifted, (m) => selectSpan(m, out.spanId))
			return chain(lifted, (m) =>
				m.timeline === null
					? { model: m }
					: liftTimeline(Timeline.setColorBy(m.timeline, out.colorBy), {
							...m,
							colorBy: out.colorBy,
						}),
			)
		},
		GotWaterfallMessage: ({ message: inner }) => {
			if (model.waterfall === null) return { model }
			const next = Waterfall.update(model.waterfall, inner)
			const out = next.outMessage
			const lifted = liftWaterfall(next, model)
			return out === undefined ? lifted : chain(lifted, (m) => selectSpan(m, out.spanId))
		},
		GotFlowMessage: ({ message: inner }) => updateFlow(model, inner),
		// The events list's copy buttons and stack trace toggles; the panel's other answers never come.
		GotPanelMessage: ({ message: inner }) => {
			if (model.panel === null) return { model }
			const next = SpanPanel.update(model.panel, inner)
			return {
				model: { ...model, panel: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotPanelMessage({ message: child }),
				),
			}
		},
	})
