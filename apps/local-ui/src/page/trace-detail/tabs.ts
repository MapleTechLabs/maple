import { findSpan } from "@maple/web/page/traces/detail/select"
import * as Timeline from "@maple/web/page/traces/detail/timeline"
import { toSpanNode, type SpanNodeData, type TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import { Option } from "effect"
import { Command } from "foldkit"
import { queryOf } from "../../route"
import type { PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"

// `TraceViewTabs`: the hash's `view` picks the tab (timeline by default), `spanId` the selection.

export type TraceView = "waterfall" | "timeline" | "flow"
export const TAB_VALUES: ReadonlyArray<TraceView> = ["waterfall", "timeline", "flow"]

const isTraceView = (value: string | null): value is TraceView => TAB_VALUES.some((view) => view === value)

export const viewOf = (context: PageContext): TraceView => {
	const raw = queryOf(context.location).get("view")
	return isTraceView(raw) ? raw : "timeline"
}

/** `findSpanNode`: the hash's `spanId` in the rendered tree. */
export const selectedSpanOf = (trace: TraceData, context: PageContext): SpanNodeData | undefined => {
	const spanId = queryOf(context.location).get("spanId") || undefined
	return spanId === undefined ? undefined : findSpan(trace.rootSpans, spanId)
}

type TabStep = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message>> }>

/** Base UI mounts only the active tab's panel: build its Submodel, drop the others. */
export const enterTab = (model: Model, trace: TraceData, view: TraceView, selectedSpanId: string | null): TabStep => {
	const cleared: Model = { ...model, timeline: null, waterfall: null, flow: null, tabs: { ...model.tabs, selected: view } }
	if (view === "timeline") {
		const next = Timeline.init({
			trace,
			traceStartTime: trace.traceStartTime ?? "",
			selectedSpanId,
			colorBy: model.colorBy,
			spanEvents: null,
		})
		return {
			model: { ...cleared, timeline: next.model },
			commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotTimelineMessage({ message })),
		}
	}
	if (view === "waterfall") {
		const next = Waterfall.init({ trace, traceStartTime: trace.traceStartTime ?? "", selectedSpanId })
		return {
			model: { ...cleared, waterfall: next.model },
			commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotWaterfallMessage({ message })),
		}
	}
	const graph = TraceFlow.buildFlowGraph({
		rootSpans: trace.rootSpans.map(toSpanNode),
		totalDurationMs: trace.totalDurationMs,
		services: [...new Set(trace.spans.map((span) => span.serviceName))],
	})
	const flowModel = { ...TraceFlow.init(), selectedSpanId: Option.fromNullishOr(selectedSpanId) }
	return { model: { ...cleared, flow: { graph, model: flowModel } } }
}

/** The selection changed under an open tab: legacy re-renders it with the new `selectedSpanId`. */
export const selectInTab = (model: Model, spanId: string | null): TabStep => {
	if (model.timeline !== null) {
		const next = Timeline.setSelectedSpanId(model.timeline, spanId)
		return {
			model: { ...model, timeline: next.model },
			commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotTimelineMessage({ message })),
		}
	}
	if (model.waterfall !== null) {
		const next = Waterfall.setSelectedSpanId(model.waterfall, spanId)
		return {
			model: { ...model, waterfall: next.model },
			commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotWaterfallMessage({ message })),
		}
	}
	return model.flow === null
		? { model }
		: {
				model: { ...model, flow: { ...model.flow, model: { ...model.flow.model, selectedSpanId: Option.fromNullishOr(spanId) } } },
			}
}
