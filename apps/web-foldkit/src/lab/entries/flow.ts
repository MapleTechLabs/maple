import { FLOW_LAB_TRACE } from "@maple/web/lab/flow-fixture"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { findSpanById } from "../../service-map/trace-flow/flow-graph"
import * as TraceFlow from "../../service-map/trace-flow/trace-flow"
import { view as traceFlowView } from "../../service-map/trace-flow/view"
import { defineLab } from "../define"
import { dashboardShell } from "../shell/dashboard-shell"

// `/lab/flow` (apps/web `lab/flow-lab.tsx`): the synthetic trace in the flow view, inside the
// dashboard shell, with the selected span's name in the header.

const graph = TraceFlow.buildFlowGraph({
	rootSpans: FLOW_LAB_TRACE.rootSpans,
	totalDurationMs: FLOW_LAB_TRACE.totalDurationMs,
	services: FLOW_LAB_TRACE.services,
})

const update = TraceFlow.update(graph)

const selectedName = (model: TraceFlow.Model): string =>
	Option.match(model.selectedSpanId, {
		onNone: () => "none",
		onSome: (spanId) => findSpanById([...FLOW_LAB_TRACE.rootSpans], spanId)?.spanName ?? "none",
	})

const toSelf = (message: TraceFlow.Message): TraceFlow.Message => message

const view = (model: TraceFlow.Model, h: HtmlBuilder<TraceFlow.Message>): Html =>
	dashboardShell(
		h,
		"Flow Lab",
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
								h.span([h.Class("font-mono")], [selectedName(model)]),
							],
						),
					],
				),
				h.div([h.Class("min-h-0 flex-1")], [traceFlowView(h, graph, model, toSelf)]),
			],
		),
	)

export const lab = defineLab("Trace flow", {
	Model: TraceFlow.Model,
	init: () => ({ model: TraceFlow.init() }),
	update: (model, message) => ({ model: update(model, message) }),
	view,
})
