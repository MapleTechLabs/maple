import { FLOW_LAB_TRACE } from "./flow-fixture"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { dashboardPage } from "../page/kit/dashboard-page"
import { findSpanById } from "../service-map/trace-flow/flow-graph"
import * as TraceFlow from "../service-map/trace-flow/trace-flow"
import { view as traceFlowView } from "../service-map/trace-flow/view"

// The flow lab under the shell: the synthetic trace in the flow view, with the
// selected span's name in the header. Shell-free so scene tests can render it.

export const FLOW_LAB_GRAPH = TraceFlow.buildFlowGraph({
	rootSpans: FLOW_LAB_TRACE.rootSpans,
	totalDurationMs: FLOW_LAB_TRACE.totalDurationMs,
	services: FLOW_LAB_TRACE.services,
})

const selectedName = (model: TraceFlow.Model): string =>
	Option.match(model.selectedSpanId, {
		onNone: () => "none",
		onSome: (spanId) => findSpanById([...FLOW_LAB_TRACE.rootSpans], spanId)?.spanName ?? "none",
	})

export const pageBody = <M>(
	h: HtmlBuilder<M>,
	flow: TraceFlow.Model,
	toMessage: (message: TraceFlow.Message) => M,
): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("flex h-full flex-col")],
			[
				h.div(
					[h.Class("border-b px-4 py-3")],
					[
						h.h1([h.Class("text-sm font-semibold")], ["Flow Lab"]),
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Synthetic trace exercising every Flow view card variant. Selected:",
								" ",
								h.span([h.Class("font-mono")], [selectedName(flow)]),
							],
						),
					],
				),
				h.div([h.Class("min-h-0 flex-1")], [traceFlowView(h, FLOW_LAB_GRAPH, flow, toMessage)]),
			],
		),
	])
