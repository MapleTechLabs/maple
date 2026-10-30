import { toSpanNode, type TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import { Option } from "effect"
import { Update } from "foldkit"
import { initAndSet } from "foldkit/bindingInit"
import { TabsBinding, TimelineBinding, WaterfallBinding } from "./composition"
import { makeFieldsStep, makeNoopStep, makeStep } from "./definition"
import type { Model } from "./model"
import type { TraceView } from "./views"

// `TraceViewTabs`' tab switches: Base UI mounts only the active tab's panel.

/** The mounted tab's Block (or the flow graph), built for `view`. */
const mountTabStep = (trace: TraceData, view: TraceView, selectedSpanId: string | null) => {
	const traceStartTime = trace.traceStartTime ?? ""
	if (view === "timeline")
		return makeStep((model: Model) =>
			initAndSet(TimelineBinding, model, {
				args: [{ trace, traceStartTime, selectedSpanId, colorBy: model.colorBy, spanEvents: null }],
			}),
		)
	if (view === "waterfall")
		return makeStep((model: Model) =>
			initAndSet(WaterfallBinding, model, { args: [{ trace, traceStartTime, selectedSpanId }] }),
		)
	const graph = TraceFlow.buildFlowGraph({
		rootSpans: trace.rootSpans.map(toSpanNode),
		totalDurationMs: trace.totalDurationMs,
		services: [...new Set(trace.spans.map((span) => span.serviceName))],
	})
	const flowModel = { ...TraceFlow.init(), selectedSpanId: Option.fromNullishOr(selectedSpanId) }
	return makeFieldsStep(() => ({ flow: () => ({ graph, model: flowModel }) }))
}

/** Enters `view`: the tab strip follows, the other tabs' Blocks are dropped and this one's built. */
export const enterTabStep = (trace: TraceData, view: TraceView, selectedSpanId: string | null) =>
	Update.combineSteps([
		makeFieldsStep(() => ({
			timeline: () => Option.none(),
			waterfall: () => Option.none(),
			flow: () => null,
		})),
		TabsBinding.informOfSelection({ value: view }),
		mountTabStep(trace, view, selectedSpanId),
	])

/** The selection changed under an open tab: legacy re-renders it with the new `selectedSpanId`. */
export const selectInTabStep = (spanId: string | null) =>
	makeStep((model: Model) => {
		if (Option.isSome(model.timeline)) return TimelineBinding.informSelectedSpanId({ spanId })
		if (Option.isSome(model.waterfall)) return WaterfallBinding.informSelectedSpan({ spanId })
		const { flow } = model
		return flow === null
			? makeNoopStep()
			: makeFieldsStep(() => ({
					flow: () => ({
						...flow,
						model: { ...flow.model, selectedSpanId: Option.fromNullishOr(spanId) },
					}),
				}))
	})
