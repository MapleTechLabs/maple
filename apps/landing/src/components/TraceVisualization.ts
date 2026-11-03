import { findSpanById } from "@maple/views/service-map/trace-flow/flow-graph"
import * as TraceFlow from "@maple/views/service-map/trace-flow/trace-flow"
import * as Flamegraph from "@maple/views/traces/flamegraph"
import { Command, type Update } from "foldkit"
import { Option, Schema } from "effect"
import { makeIsland } from "../foldkit-island/island"
import { ROOT_SPANS } from "./trace-explorer/fixture"
import { FLAME_ID, FLOW_GRAPH, Message, Model, type Tab, TRACE_INPUT } from "./trace-explorer/model"
import { view } from "./trace-explorer/view"

/**
 * The trace explorer artifact on /features/distributed-tracing: the dashboard's Foldkit trace flow
 * and flamegraph over a fixture trace, with a waterfall between them. One selected span is shared
 * by all three tabs; clicking it again clears it.
 */

const updateFlow = TraceFlow.update(FLOW_GRAPH)
const updateFlame = Flamegraph.update(TRACE_INPUT)

type Return = Update.Return<Model, Message>

const toggle = (model: Model, spanId: string): Model => ({
	...model,
	selectedSpanId: Option.contains(model.selectedSpanId, spanId) ? Option.none() : Option.some(spanId),
})

// The flow draws its selection from its own Model; the island's selection is the one source.
const synced = (model: Model): Model =>
	Option.getOrUndefined(model.flow.selectedSpanId) === Option.getOrUndefined(model.selectedSpanId)
		? model
		: { ...model, flow: { ...model.flow, selectedSpanId: model.selectedSpanId } }

const switchTab = (model: Model, tab: Tab): Model =>
	tab === model.tab
		? model
		: {
				...model,
				tab,
				// A tab mounts afresh, like the components it replaces: fitted again, zoomed out.
				flow: tab === "flow" ? TraceFlow.init(TraceFlow.FIT_ALL) : model.flow,
				flame: tab === "flamegraph" ? Flamegraph.init(FLAME_ID) : model.flame,
			}

const step = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedTab: ({ tab }) => ({ model: switchTab(model, tab) }),
		ClickedWaterfallRow: ({ spanId }) => ({ model: toggle(model, spanId) }),
		GotFlowMessage: ({ message: inner }) => {
			if (inner._tag !== "ClickedSpanNode")
				return { model: { ...model, flow: updateFlow(model.flow, inner) } }
			const span = findSpanById(ROOT_SPANS, inner.nodeId)
			return { model: span === undefined ? model : toggle(model, span.spanId) }
		},
		GotFlameMessage: ({ message: inner }) => {
			const next = updateFlame(model.flame, inner)
			const flamed = { ...model, flame: next.model }
			return {
				model: next.outMessage === undefined ? flamed : toggle(flamed, next.outMessage.spanId),
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotFlameMessage({ message: m }),
				),
			}
		},
	})

export const update = (model: Model, message: Message): Return => {
	const next = step(model, message)
	return { ...next, model: synced(next.model) }
}

export const init = (): Model => ({
	tab: "flow",
	selectedSpanId: Option.none(),
	flow: TraceFlow.init(TraceFlow.FIT_ALL),
	flame: Flamegraph.init(FLAME_ID),
})

export const TraceVisualization = makeIsland({
	name: "TraceVisualization",
	Props: Schema.Struct({}),
	Model,
	init: () => ({ model: init() }),
	update,
	view,
})
