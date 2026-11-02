import { view as traceFlowView } from "@maple/views/service-map/trace-flow/view"
import { view as flamegraphView } from "@maple/views/traces/flamegraph-view"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { BASE_TIME, SERVICES, TOTAL_DURATION_MS, TRACE_ID, WATERFALL_ROWS } from "./fixture"
import { FLOW_GRAPH, Message, type Model, type Tab, TRACE_INPUT } from "./model"

type H = HtmlBuilder<Message>

const TABS: ReadonlyArray<readonly [Tab, string]> = [
	["flow", "Flow"],
	["waterfall", "Waterfall"],
	["flamegraph", "Flamegraph"],
]
const CHART_BG = { 1: "bg-chart-1", 2: "bg-chart-2", 3: "bg-chart-3", 4: "bg-chart-4" } as const
const CHART_TEXT = { 1: "text-chart-1", 2: "text-chart-2", 3: "text-chart-3", 4: "text-chart-4" } as const
const SERVICE_TEXT = [CHART_TEXT[1], CHART_TEXT[2], CHART_TEXT[3], CHART_TEXT[4]] as const
const STATUS_CHIP = "bg-[color:var(--severity-info)]/10 text-[color:var(--severity-info)]"
const AXIS = ["0ms", "50ms", "100ms", "150ms", "203ms"] as const

const formatMs = (ms: number): string => (ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`)

const summary = (h: H): Html =>
	h.div(
		[h.Class("px-4 py-3 border-b border-border bg-background")],
		[
			h.div([h.Class("text-xs text-foreground font-medium mb-2")], ["POST /checkout"]),
			h.div([h.Class("text-[10px] text-muted-foreground mb-3")], ["8 spans across 4 services"]),
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					...SERVICES.map((service, index) =>
						h.span(
							[
								h.Class(
									`text-[9px] border border-border px-1.5 py-0.5 font-mono ${SERVICE_TEXT[index]}`,
								),
							],
							[service],
						),
					),
					h.span(
						[h.Class("text-[9px] border border-border px-1.5 py-0.5 text-muted-foreground")],
						["203ms"],
					),
					h.span([h.Class(`text-[9px] px-1.5 py-0.5 ${STATUS_CHIP}`)], ["Ok"]),
				],
			),
		],
	)

const tabBar = (h: H, current: Tab): Html =>
	h.div(
		[h.Class("flex items-center gap-0 border-b border-border bg-background px-4"), h.Role("tablist")],
		TABS.map(([tab, label]) =>
			h.button(
				[
					h.Type("button"),
					h.Role("tab"),
					h.AriaSelected(tab === current),
					h.OnClick(Message.ClickedTab({ tab })),
					h.Class(
						`text-[10px] px-3 py-2 border-b-2 transition-colors ${
							tab === current
								? "text-foreground font-medium border-primary"
								: "text-muted-foreground border-transparent hover:text-foreground"
						}`,
					),
				],
				[label],
			),
		),
	)

const waterfallRow = (h: H, row: (typeof WATERFALL_ROWS)[number], selected: Option.Option<string>): Html => {
	const { span, color } = row
	const startPct =
		((new Date(span.startTime).getTime() - new Date(BASE_TIME).getTime()) / TOTAL_DURATION_MS) * 100
	const widthPct = (span.durationMs / TOTAL_DURATION_MS) * 100
	// Row fill only: selection is carried by tone, never a coloured left stripe (DESIGN.md §6).
	const tone = Option.contains(selected, span.spanId) ? "bg-primary/10" : "hover:bg-muted/20"
	return h.keyed("div")(
		span.spanId,
		[
			h.Class(`flex items-center px-4 py-1.5 text-[10px] transition-colors cursor-pointer ${tone}`),
			h.OnClick(Message.ClickedWaterfallRow({ spanId: span.spanId })),
			h.Role("button"),
			h.Tabindex(0),
			h.AriaPressed(Option.contains(selected, span.spanId) ? "true" : "false"),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter" || key === " "
					? Option.some(Message.ClickedWaterfallRow({ spanId: span.spanId }))
					: Option.none(),
			),
		],
		[
			h.div(
				[
					h.Class("w-28 md:w-36 shrink-0 flex items-center gap-1"),
					h.Style({ "padding-left": `${span.depth * 12}px` }),
				],
				[
					...(span.depth > 0 ? [h.span([h.Class("text-muted-foreground/30")], ["└"])] : []),
					h.span([h.Class(`w-1.5 h-1.5 shrink-0 ${CHART_BG[color]}`)]),
					h.span(
						[h.Class(`font-mono text-[9px] truncate ${CHART_TEXT[color]}`)],
						[span.serviceName],
					),
				],
			),
			h.span(
				[
					h.Class(
						"w-20 md:w-28 shrink-0 text-muted-foreground font-mono text-[9px] truncate hidden sm:block",
					),
				],
				[span.spanName],
			),
			h.div(
				[h.Class("flex-1 relative h-4 mx-2 hidden sm:block")],
				[
					h.div(
						[
							h.Class(`absolute top-0.5 h-3 ${CHART_BG[color]}`),
							h.Style({ left: `${startPct}%`, width: `${widthPct}%` }),
						],
						[
							h.span(
								[
									h.Class(
										"text-[8px] text-background px-1 leading-3 truncate block font-medium",
									),
								],
								[span.spanName],
							),
						],
					),
				],
			),
			h.span(
				[h.Class("w-14 text-right shrink-0 text-muted-foreground font-mono text-[9px]")],
				[formatMs(span.durationMs)],
			),
			h.span(
				[h.Class("w-12 text-right shrink-0")],
				[h.span([h.Class(`text-[8px] px-1 py-0.5 ${STATUS_CHIP}`)], [span.statusCode])],
			),
		],
	)
}

const waterfall = (h: H, selected: Option.Option<string>): Html =>
	h.div(
		[],
		[
			h.div(
				[
					h.Class(
						"hidden sm:flex items-center text-[9px] text-muted-foreground border-b border-border bg-muted/30 px-4 py-1.5",
					),
				],
				[
					h.span([h.Class("w-28 md:w-36 shrink-0")], ["Service"]),
					h.span([h.Class("w-20 md:w-28 shrink-0")], ["Span"]),
					h.span([h.Class("flex-1")], ["Timeline"]),
					h.span([h.Class("w-14 text-right shrink-0")], ["Duration"]),
					h.span([h.Class("w-12 text-right shrink-0")], ["Status"]),
				],
			),
			h.div(
				[h.Class("divide-y divide-border")],
				WATERFALL_ROWS.map((row) => waterfallRow(h, row, selected)),
			),
			h.div(
				[
					h.Class(
						"hidden sm:flex items-center justify-between px-4 py-2 border-t border-border bg-background",
					),
				],
				AXIS.map((tick) => h.span([h.Class("text-[8px] text-muted-foreground")], [tick])),
			),
		],
	)

const visualization = (h: H, model: Model): Html => {
	switch (model.tab) {
		case "flow":
			return h.div(
				[h.Class("h-[500px]")],
				[traceFlowView(h, FLOW_GRAPH, model.flow, (message) => Message.GotFlowMessage({ message }))],
			)
		case "waterfall":
			return h.div([], [waterfall(h, model.selectedSpanId)])
		case "flamegraph":
			return h.div(
				[],
				[
					flamegraphView(
						h,
						model.flame,
						{ input: TRACE_INPUT, selectedSpanId: model.selectedSpanId },
						(message) => Message.GotFlameMessage({ message }),
					),
				],
			)
	}
}

/** `.live-frame`, like every other artifact on the site: its head states the route and the trace id. */
export const view = (model: Model, h: H): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["/traces"]),
					h.span([h.Class("text-fg normal-case tracking-normal")], [TRACE_ID]),
				],
			),
			summary(h),
			tabBar(h, model.tab),
			visualization(h, model),
		],
	)
