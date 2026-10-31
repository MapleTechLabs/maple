import { formatErrorRate } from "@maple/ui/lib/format"
import {
	formatLatency,
	formatRate,
	health,
	HEALTH_LABEL,
} from "../../components/service-map/three/spatial-layout"
import type { Node3D } from "../../components/service-map/three/types"
import type { Html, HtmlBuilder } from "foldkit/html"
import { machineBadge } from "../../page/service-map/badge"
import { button } from "../../ui/button"
import { Message } from "./update"
import { healthDot, topology } from "./view-inventory"

// `ServiceInventory` with a node selected: the inspector with its inbound and outbound calls.

type H = HtmlBuilder<Message>

const nodesById = new Map(topology.nodes.map((node) => [node.id, node]))
const SEVERITY = { healthy: "info", elevated: "warn", degraded: "error" } as const

const CALL_CLASS =
	"flex w-full flex-col gap-1.5 px-4 py-2.5 text-left text-xs hover:bg-surface-strong active:bg-surface-strong focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"

const calls = (h: H, selected: Node3D, direction: "Inbound" | "Outbound"): Html => {
	const edges = topology.edges.filter((edge) =>
		direction === "Inbound" ? edge.target === selected.id : edge.source === selected.id,
	)
	return h.section(
		[h.Key(direction), h.Class("border-b py-4")],
		[
			h.h3(
				[h.Class("mb-2 flex justify-between px-4 text-xs text-muted-foreground")],
				[h.span([], [`${direction} calls`]), h.span([], [String(edges.length)])],
			),
			...(edges.length === 0
				? [
						h.p(
							[h.Class("px-4 py-2 text-xs text-muted-foreground")],
							[`No ${direction.toLowerCase()} calls in this sample.`],
						),
					]
				: []),
			...edges.flatMap((edge) => {
				const node = nodesById.get(direction === "Inbound" ? edge.source : edge.target)
				if (node === undefined) return []
				return [
					h.button(
						[
							h.Key(`${edge.source}:${edge.target}`),
							h.Type("button"),
							h.Class(CALL_CLASS),
							h.OnClick(Message.ClickedNode({ nodeId: node.id })),
						],
						[
							h.span(
								[h.Class("flex w-full items-center gap-2")],
								[
									healthDot(h, node),
									h.span([h.Class("truncate")], [node.label]),
									h.span([h.Class("ml-auto text-muted-foreground")], ["→"]),
								],
							),
							h.span(
								[h.Class("pl-3.5 text-muted-foreground")],
								[
									`${formatRate(edge.callsPerSecond)} · ${formatLatency(edge.p95LatencyMs)} p95`,
								],
							),
						],
					),
				]
			}),
		],
	)
}

export const inspector = (h: H, selected: Node3D): Html => {
	const badge = machineBadge(selected)
	const status = health(selected.errorRate)
	return h.aside(
		[
			h.Class(
				"flex max-h-120 min-h-80 flex-col overflow-y-auto border-t bg-background xl:max-h-none xl:min-h-0 xl:border-t-0 xl:border-l",
			),
			h.AriaLabel("Service inspector"),
		],
		[
			h.div(
				[h.Class("border-b p-4")],
				[
					button(
						h,
						{
							variant: "ghost",
							size: "xs",
							className: "-ml-2 mb-4 text-muted-foreground",
							attributes: [h.OnClick(Message.ClickedNode({ nodeId: null }))],
						},
						["← All services"],
					),
					h.div(
						[h.Class("mb-1 flex items-center gap-2")],
						[
							healthDot(h, selected),
							h.h2([h.Class("min-w-0 break-all text-sm font-semibold")], [selected.label]),
						],
					),
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						[`${selected.namespace}${badge === null ? "" : ` / ${badge.label}`}`],
					),
					h.div(
						[
							h.Class("mt-4 inline-flex items-center gap-1.5 text-xs capitalize"),
							h.Style({ color: `var(--color-severity-${SEVERITY[status]})` }),
						],
						[
							HEALTH_LABEL[status],
							h.span(
								[h.Class("text-muted-foreground")],
								[`· ${formatErrorRate(selected.errorRate)} errors`],
							),
						],
					),
				],
			),
			h.dl(
				[h.Class("grid grid-cols-2 gap-4 border-b p-4 text-xs")],
				[
					h.div(
						[],
						[
							h.dt([h.Class("mb-1.5 text-muted-foreground")], ["Throughput"]),
							h.dd([h.Class("text-base tabular-nums")], [formatRate(selected.throughput)]),
						],
					),
					h.div(
						[],
						[
							h.dt([h.Class("mb-1.5 text-muted-foreground")], ["p95 latency"]),
							h.dd([h.Class("text-base tabular-nums")], [formatLatency(selected.p95LatencyMs)]),
						],
					),
				],
			),
			calls(h, selected, "Inbound"),
			calls(h, selected, "Outbound"),
			h.p(
				[h.Class("mt-auto p-4 text-2xs leading-relaxed text-muted-foreground")],
				["Select a connected service to follow the request path."],
			),
		],
	)
}
