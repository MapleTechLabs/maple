import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { pathsTooltip } from "./paths-tooltip"
import {
	labelOf,
	layoutPaths,
	NODE_W,
	type PathLink,
	type PathsLayout,
	type PlacedNode,
	ribbon,
	toGraph,
} from "./paths-layout"

// Port of `PathsChart` (packages/ui/src/components/charts/paths/paths-chart.tsx). The hovered node
// id is the chart Model's `activeKey`; the measured box is its container size.

export interface PathsChartInputs {
	readonly data: ReadonlyArray<Record<string, unknown>>
	readonly className?: string | undefined
	readonly direction?: "after" | "before" | undefined
}

type H = HtmlBuilder<Message>

const TWO_LINE_H = 26
const HALO = { "paint-order": "stroke", stroke: "var(--card)", "stroke-width": "3", "stroke-linejoin": "round" }
const CHAR_W = 6.6

const attrs = (h: H, entries: Readonly<Record<string, string | number>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, String(value)))

const fillOpacity = (kind: PlacedNode["kind"], lit: boolean, dim: boolean): number =>
	dim ? 0.05 : kind === "event" ? (lit ? 0.65 : 0.2) : kind === "end" ? (lit ? 0.3 : 0.07) : lit ? 0.4 : 0.12

type Labels = Readonly<{ truncate: (label: string) => string; showCounts: boolean }>

const columnHeaders = (h: H, graph: PathsLayout, reverse: boolean): ReadonlyArray<Html> =>
	graph.columns.map((column, index) => {
		const last = index === graph.columns.length - 1
		const firstId = [...graph.nodes.keys()].find((id) => id.startsWith(`${column}:`)) ?? ""
		const x = graph.nodes.get(firstId)?.x ?? 0
		const label = column === 0 ? "Anchor" : reverse ? `−${column}` : `Step ${column}`
		const atRightEdge = reverse ? column === 0 : last
		return h.text(
			[
				...attrs(h, { x: atRightEdge ? x + NODE_W : x, y: 10, "text-anchor": atRightEdge ? "end" : "start" }),
				h.Class("fill-muted-foreground text-3xs font-medium uppercase tracking-wider"),
			],
			[label],
		)
	})

const ribbons = (h: H, graph: PathsLayout, isLit: (link: PathLink) => boolean, hover: string | null) =>
	graph.links.map((link) => {
		const kind = graph.nodes.get(link.target)?.kind ?? "event"
		const lit = isLit(link)
		return h.path([
			h.Attribute("d", ribbon(link.x0, link.sy, link.x1, link.ty, link.h)),
			h.Class(
				cn(
					"pointer-events-none",
					kind === "event" && "fill-[var(--chart-2)]",
					kind === "end" && "fill-foreground",
					kind === "other" && "fill-foreground",
				),
			),
			h.Style({
				"fill-opacity": String(fillOpacity(kind, lit, hover !== null && !lit)),
				transition: "fill-opacity 140ms ease",
			}),
		])
	})

const nodeGroup = (
	h: H,
	node: PlacedNode,
	reverse: boolean,
	dim: boolean,
	labels: Labels,
): Html => {
	const labelLeft = reverse ? node.column !== 0 : node.column === 0
	const textX = labelLeft ? node.x + NODE_W + 6 : node.x - 6
	const showText = node.h >= 9 || node.kind !== "event"
	const twoLine = node.h >= TWO_LINE_H
	const countInline = labels.showCounts && !twoLine
	const label = labels.truncate(labelOf(node))
	const hitLabelW = showText ? (label.length + (countInline ? 7 : 0)) * CHAR_W + 6 : 0
	return h.g(
		[
			h.OnMouseEnter(Message.EnteredLegendItem({ key: node.id })),
			h.Style({ opacity: dim ? "0.45" : "1", transition: "opacity 140ms ease" }),
			h.DataAttribute("slot", "paths-node"),
		],
		[
			h.rect([
				...attrs(h, { x: node.x, y: node.y, width: NODE_W, height: node.h, rx: 2 }),
				h.Class(
					cn(
						node.kind === "event" && "fill-[var(--chart-2)]",
						node.kind === "end" && "fill-foreground/20",
						node.kind === "other" && "fill-foreground/35",
					),
				),
			]),
			h.rect([
				...attrs(h, {
					x: labelLeft ? node.x - 6 : node.x - 6 - hitLabelW,
					y: node.y - 2,
					width: NODE_W + 12 + hitLabelW,
					height: Math.max(node.h, 12) + 4,
					fill: "transparent",
				}),
				h.DataAttribute("slot", "paths-node-hit"),
			]),
			...(showText
				? [
						h.text(
							[
								...attrs(h, {
									x: textX,
									y: node.y + Math.min(node.h, 12) / 2 + 3.5,
									"text-anchor": labelLeft ? "start" : "end",
								}),
								h.Class(
									cn(
										"text-2xs font-medium",
										node.kind === "event" ? "fill-foreground" : "fill-muted-foreground",
									),
								),
								h.Style(HALO),
							],
							[
								label,
								...(countInline || twoLine
									? [
											" ",
											h.tspan(
												[
													...attrs(h, twoLine ? { x: textX, dy: 13 } : {}),
													h.Class("fill-muted-foreground text-3xs font-normal tabular-nums"),
												],
												[formatNumber(node.count)],
											),
										]
									: []),
							],
						),
					]
				: []),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PathsChartInputs>((model, inputs, h) => {
	const { nodes, links } = toGraph(inputs.data)
	const { containerWidth: width, containerHeight: height } = model
	const reverse = inputs.direction === "before"
	const graph = width > 0 && height > 0 ? layoutPaths(nodes, links, width, height, reverse) : undefined
	const anchor = nodes.find((node) => node.column === 0)
	if (anchor === undefined || anchor.count <= 0)
		return h.div(
			[h.Class(cn("relative grid h-full w-full place-items-center", inputs.className))],
			[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
		)
	const columnSpan =
		graph !== undefined && graph.columns.length > 1 ? (width - NODE_W) / (graph.columns.length - 1) : width
	const roomChars = Math.floor((columnSpan * 0.7 - 20) / CHAR_W)
	const showCounts = roomChars >= 14
	const maxChars = Math.max(6, showCounts ? roomChars - 6 : roomChars)
	const labels: Labels = {
		showCounts,
		truncate: (label) => (label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label),
	}
	const hover = Option.getOrNull(model.activeKey)
	const hoveredNode = hover === null ? undefined : graph?.nodes.get(hover)
	const isLit = (link: PathLink) => hover !== null && (link.source === hover || link.target === hover)
	return h.div(
		[
			h.Class(cn("relative h-full w-full select-none", inputs.className)),
			h.OnMount(MeasureChartContainer()),
			h.OnMouseLeave(Message.LeftChart()),
			h.DataAttribute("slot", "paths-chart"),
		],
		[
			...(graph === undefined
				? []
				: [
						h.svg(
							[
								h.Attribute("viewBox", `0 0 ${width} ${height}`),
								h.Class("block h-full w-full overflow-visible"),
							],
							[
								...columnHeaders(h, graph, reverse),
								...ribbons(h, graph, isLit, hover),
								...[...graph.nodes.values()].map((node) =>
									nodeGroup(
										h,
										node,
										reverse,
										hover !== null &&
											hover !== node.id &&
											!links.some(
												(link) =>
													isLit(link) && (link.source === node.id || link.target === node.id),
											),
										labels,
									),
								),
							],
						),
					]),
			...(hoveredNode !== undefined && graph !== undefined
				? [pathsTooltip(h, { node: hoveredNode, anchor, graph, links, width, height, reverse })]
				: []),
		],
	)
})
