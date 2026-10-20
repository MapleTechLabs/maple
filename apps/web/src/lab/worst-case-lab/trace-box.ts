import { Option, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Timeline from "../../page/traces/detail/timeline"
import { TraceData, toSpanNode } from "../../page/traces/detail/trace-data"
import * as Waterfall from "../../page/traces/detail/waterfall"
import type { Resources } from "../../platform/resources"
import * as TraceFlow from "../../service-map/trace-flow/trace-flow"
import * as Tabs from "../../ui/tabs"

// `TraceBox`: a controlled `TraceViewTabs` over one trace, its
// own tab and selected span, the way `/lab/timeline` hosts the trace page's Submodels.

export const TAB_VALUES = ["waterfall", "timeline", "flow"]

export const Model = Schema.Struct({
	trace: TraceData,
	tabs: Tabs.Model,
	colorBy: Schema.String,
	selectedSpanId: Schema.NullOr(Schema.String),
	timeline: Schema.NullOr(Timeline.Model),
	waterfall: Schema.NullOr(Waterfall.Model),
	flow: Schema.NullOr(TraceFlow.Model),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotTabsMessage: { message: Tabs.Message },
	GotTimelineMessage: { message: Timeline.Message },
	GotWaterfallMessage: { message: Waterfall.Message },
	GotFlowMessage: { message: TraceFlow.Message },
})
export type Message = typeof Message.Type

export type Return = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

export const flowGraphOf = (trace: TraceData): TraceFlow.FlowGraph =>
	TraceFlow.buildFlowGraph({
		rootSpans: trace.rootSpans.map(toSpanNode),
		totalDurationMs: trace.totalDurationMs,
		services: [...new Set(trace.spans.map((span) => span.serviceName))],
	})

const liftTimeline = (step: Timeline.UpdateReturn, model: Model): Return => ({
	model: { ...model, timeline: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotTimelineMessage({ message })),
})

const liftWaterfall = (step: Waterfall.UpdateReturn, model: Model): Return => ({
	model: { ...model, waterfall: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotWaterfallMessage({ message })),
})

/** Base UI mounts only the active tab's panel: build its Submodel, drop the others. */
const enterTab = (model: Model, view: string): Return => {
	const cleared: Model = { ...model, timeline: null, waterfall: null, flow: null }
	const { trace, selectedSpanId } = model
	const traceStartTime = trace.traceStartTime ?? ""
	if (view === "timeline")
		return liftTimeline(
			Timeline.init({
				trace,
				traceStartTime,
				selectedSpanId,
				colorBy: model.colorBy,
				spanEvents: null,
			}),
			cleared,
		)
	if (view === "waterfall")
		return liftWaterfall(Waterfall.init({ trace, traceStartTime, selectedSpanId }), cleared)
	return {
		model: {
			...cleared,
			flow: { ...TraceFlow.init(), selectedSpanId: Option.fromNullishOr(selectedSpanId) },
		},
	}
}

export type InitInput = Readonly<{ trace: TraceData; view: string; selectedSpanId: string; idBase: number }>

/** `useState(initialView)` and `useState(deepestSpanId)`: the tab and the selection start set. */
export const init = (input: InitInput): Return =>
	enterTab(
		{
			trace: input.trace,
			tabs: Tabs.init({ idBase: input.idBase, values: TAB_VALUES, selected: input.view }),
			colorBy: "service",
			selectedSpanId: input.selectedSpanId,
			timeline: null,
			waterfall: null,
			flow: null,
		},
		input.view,
	)

/** `onSelectSpan`: the open tab re-renders with the span. */
const selectSpan = (model: Model, spanId: string): Return => {
	if (model.selectedSpanId === spanId) return { model }
	const next: Model = { ...model, selectedSpanId: spanId }
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

const updateFlow = (model: Model, message: TraceFlow.Message): Return => {
	if (model.flow === null) return { model }
	const flow = TraceFlow.update(flowGraphOf(model.trace))(model.flow, message)
	const picked = Option.getOrUndefined(flow.selectedSpanId)
	const next: Model = { ...model, flow }
	return message._tag === "ClickedSpanNode" && picked !== undefined
		? selectSpan(next, picked)
		: { model: next }
}

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
			// `onViewChange={setView}`: the box follows the tab the reader picked.
			return next.model.selected === model.tabs.selected
				? lifted
				: chain(lifted, (m) => enterTab(m, next.model.selected))
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
	})
