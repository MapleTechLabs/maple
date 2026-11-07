import {
	DB_NODE_PREFIX,
	NS_LABEL_HEIGHT,
	NS_PADDING_X,
	NS_PADDING_Y,
} from "@maple/ui/components/service-map/service-map-utils"
import { getValueHue } from "@maple/ui/lib/colors"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { pressable } from "../../ui/pressable"
import type { MeasuredNode } from "../xyflow/geometry"
import { flowNode } from "../xyflow/view"
import type { EffectiveGraph } from "./graph"
import type { Positions } from "./service-map"
import { Array as Arr, String as Str } from "effect"
import { hstack } from "../../ui/stack"
import { typography } from "../../ui/typography"

// The dotted namespace boxes `ServiceMapFlowCanvas` derives from node extents, and
// `NamespaceGroupNode` (packages/ui `service-map/service-map-namespace-group.tsx`).

const FALLBACK_NODE_WIDTH = 220
const FALLBACK_NODE_HEIGHT = 70

const nsGroupId = (namespace: string) => `nsgroup:${encodeURIComponent(namespace)}`

const box = <M>(h: HtmlBuilder<M>, label: string, hue: number, onCollapse: M): Html =>
	h.div(
		[
			h.Class("pointer-events-none h-full w-full rounded-xl border-[1.5px] border-dashed"),
			h.Style({
				"border-color": `oklch(0.66 0.12 ${hue} / 0.7)`,
				"background-color": `oklch(0.62 0.11 ${hue} / 0.05)`,
			}),
		],
		[
			hstack(
				h,
				{
					gap: "1.5",
					align: "center",
					as: "span",
					className:
						"pointer-events-auto absolute left-2.5 top-2 max-w-[calc(100%-1.25rem)] rounded-md border px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-widest",
					attributes: [
						h.Style({
							// Mixed against the theme so the label reads on the light canvas too.
							color: `color-mix(in oklab, oklch(0.62 0.14 ${hue}) 70%, var(--foreground))`,
							"background-color": `color-mix(in oklab, oklch(0.62 0.11 ${hue}) 14%, var(--background))`,
							"border-color": `oklch(0.66 0.12 ${hue} / 0.4)`,
						}),
					],
				},
				[
					typography(h, { truncate: true }, [label]),
					pressable(
						h,
						{
							className:
								"shrink-0 opacity-60 transition-opacity hover:opacity-100 active:opacity-100",
							attributes: [
								h.Title(`Collapse ${label} into one node`),
								h.OnClick(onCollapse, { propagation: "Stop" }),
							],
						},
						[icon(h, "MinimizeIcon", { size: 10 })],
					),
				],
			),
		],
	)

export interface NamespaceBox {
	readonly id: string
	readonly namespace: string
	readonly position: { readonly x: number; readonly y: number }
	readonly width: number
	readonly height: number
}

/** Each namespace's box: its service nodes' extent (measured, else the fallback size) plus padding. */
export const namespaceBoxRects = (
	graph: EffectiveGraph,
	positions: Positions,
	measured: Readonly<Record<string, MeasuredNode>>,
): ReadonlyArray<NamespaceBox> => {
	const extents = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
	for (const node of graph.nodes) {
		const ns = node.data.namespace
		if (Str.startsWith(DB_NODE_PREFIX)(node.id) || !ns) continue
		const w = measured[node.id]?.width ?? FALLBACK_NODE_WIDTH
		const hgt = measured[node.id]?.height ?? FALLBACK_NODE_HEIGHT
		const { x, y } = positions[node.id] ?? node.position
		const ext = extents.get(ns)
		if (ext) {
			ext.minX = Math.min(ext.minX, x)
			ext.minY = Math.min(ext.minY, y)
			ext.maxX = Math.max(ext.maxX, x + w)
			ext.maxY = Math.max(ext.maxY, y + hgt)
		} else extents.set(ns, { minX: x, minY: y, maxX: x + w, maxY: y + hgt })
	}
	return Arr.map([...extents], ([ns, ext]) => ({
		id: nsGroupId(ns),
		namespace: ns,
		position: { x: ext.minX - NS_PADDING_X, y: ext.minY - (NS_LABEL_HEIGHT + NS_PADDING_Y) },
		width: ext.maxX - ext.minX + NS_PADDING_X * 2,
		height: ext.maxY - ext.minY + NS_LABEL_HEIGHT + NS_PADDING_Y * 2,
	}))
}

/** One box per namespace around its measured service nodes, painted behind them. */
export const namespaceBoxes = <M>(
	h: HtmlBuilder<M>,
	graph: EffectiveGraph,
	positions: Positions,
	measured: Readonly<Record<string, MeasuredNode>>,
	onCollapse: (namespace: string) => M,
): ReadonlyArray<Html> =>
	Arr.map(namespaceBoxRects(graph, positions, measured), (rect) =>
		flowNode(h, {
			id: rect.id,
			type: "namespaceGroup",
			position: rect.position,
			measured: true,
			focusable: false,
			style: { width: `${rect.width}px`, height: `${rect.height}px`, "pointer-events": "none" },
			children: [box(h, rect.namespace, getValueHue(rect.namespace) ?? 0, onCollapse(rect.namespace))],
		}),
	)
