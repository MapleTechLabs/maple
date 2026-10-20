import { formatErrorRate } from "@maple/ui/lib/format"
import { health, HEALTH_COLOR } from "../../components/service-map/three/spatial-layout"
import type { Node3D } from "../../components/service-map/three/types"
import { SERVICE_MAP_3D_TOPOLOGY } from "../service-map-3d/fixture"
import type { Html, HtmlBuilder } from "foldkit/html"
import { input } from "../../ui/input"
import { statusDot } from "../../ui/status-dot"
import { Message, type Model } from "./update"

// `ServiceInventory` with nothing selected: the searchable list sorted by error rate.

export const topology = SERVICE_MAP_3D_TOPOLOGY
type H = HtmlBuilder<Message>

export const healthDot = (h: H, node: Node3D): Html =>
	statusDot(h, { tone: "custom", attributes: [h.Style({ "background-color": HEALTH_COLOR[health(node.errorRate)] })] })

const ROW_CLASS =
	"group flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"

const row = (h: H, node: Node3D): Html =>
	h.button(
		[
			h.Key(node.id),
			h.Type("button"),
			h.OnClick(Message.ClickedNode({ nodeId: node.id })),
			h.Class(ROW_CLASS),
			h.AriaLabel(`Inspect ${node.label}`),
		],
		[
			healthDot(h, node),
			h.span(
				[h.Class("min-w-0 flex-1")],
				[
					h.span([h.Class("block truncate text-xs")], [node.label]),
					h.span(
						[h.Class("mt-0.5 block text-3xs text-muted-foreground")],
						[node.kind === "service" ? node.namespace : node.kind],
					),
				],
			),
			h.span([h.Class("shrink-0 text-2xs tabular-nums text-muted-foreground")], [formatErrorRate(node.errorRate)]),
		],
	)

const header = (h: H, model: Model): Html =>
	h.div(
		[h.Class("border-b p-4")],
		[
			h.div(
				[h.Class("flex items-center justify-between")],
				[
					h.h2([h.Class("text-xs font-semibold")], ["Services & dependencies"]),
					h.span([h.Class("text-xs text-muted-foreground")], [String(topology.nodes.length)]),
				],
			),
			h.p([h.Class("mt-2 text-2xs text-muted-foreground")], ["Select a node to inspect its calls."]),
			input(h, {
				id: "service-map-3d-find",
				className: "mt-4 h-8 text-xs",
				attributes: [
					h.AriaLabel("Find a service"),
					h.Placeholder("Find a service…"),
					h.Value(model.query),
					h.OnInput((value) => Message.ChangedQuery({ value })),
				],
			}),
		],
	)

export const inventory = (h: H, model: Model): Html => {
	const needle = model.query.trim().toLowerCase()
	const sorted = topology.nodes
		.filter((node) => `${node.label} ${node.namespace} ${node.kind}`.includes(needle))
		.toSorted((a, b) => b.errorRate - a.errorRate)
	const degraded = topology.nodes.filter((node) => health(node.errorRate) === "degraded").length
	return h.aside(
		[
			h.Class(
				"flex h-96 min-h-0 flex-col overflow-hidden border-t bg-background xl:h-auto xl:border-t-0 xl:border-l",
			),
			h.AriaLabel("Service inventory"),
		],
		[
			header(h, model),
			h.div(
				[h.Class("flex items-center justify-between border-b px-4 py-2.5 text-2xs text-muted-foreground")],
				[
					h.span([], ["Sorted by error rate"]),
					h.span([h.Class("text-severity-error")], [`${degraded} degraded`]),
				],
			),
			h.div(
				[h.Class("min-h-0 flex-1 overflow-y-auto py-1")],
				[
					...(sorted.length === 0
						? [h.p([h.Class("p-4 text-xs text-muted-foreground")], [`No services match “${model.query}”.`])]
						: []),
					...sorted.map((node) => row(h, node)),
				],
			),
			h.p(
				[h.Class("border-t px-4 py-3 text-3xs leading-relaxed text-muted-foreground")],
				["Sample health thresholds", h.br([]), "Elevated > 1% · Degraded > 5% errors"],
			),
		],
	)
}
