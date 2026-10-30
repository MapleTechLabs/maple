import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../ui/display"
import { eyebrow } from "../ui/eyebrow"
import { icon } from "../ui/icon"
import type { Message } from "./chart"
import { labelOf, NODE_W, type PathLink, type PathNode, type PathsLayout, type PlacedNode } from "./paths-layout"

// The hover card of `PathsChart`: who reached the node, and the top three flows into it.

const TIP_W = 250

type H = HtmlBuilder<Message>

export type PathsTooltipInputs = Readonly<{
	node: PlacedNode
	anchor: PathNode
	graph: PathsLayout
	links: ReadonlyArray<PathLink>
	width: number
	height: number
	reverse: boolean
}>

const cameFrom = (h: H, inputs: PathsTooltipInputs): ReadonlyArray<Html> => {
	const { node, graph, links } = inputs
	return [
		h.div([h.Class("-mx-2.5 my-1.5 h-px bg-border")]),
		eyebrow(h, { as: "div", className: "mb-1" }, ["Came from"]),
		...links
			.filter((link) => link.target === node.id)
			.toSorted((a, b) => b.count - a.count)
			.slice(0, 3)
			.map((link) => {
				const from = graph.nodes.get(link.source)
				const share = node.count > 0 ? link.count / node.count : 0
				return h.div(
					[h.Class("my-0.5")],
					[
						h.div(
							[h.Class("flex items-center gap-2 tabular-nums")],
							[
								icon(h, "ArrowLeftIcon", { size: 10, className: "shrink-0 text-muted-foreground" }),
								h.span(
									[h.Class("min-w-0 flex-1 truncate text-foreground-soft")],
									[from === undefined ? "" : labelOf(from)],
								),
								h.span([h.Class("text-muted-foreground")], [link.count.toLocaleString("en-US")]),
							],
						),
						h.div(
							[h.Class("relative mt-0.5 ml-4 h-1 rounded-sm bg-foreground/5")],
							[
								h.div([
									h.Class("absolute inset-y-0 left-0 rounded-sm bg-chart-2/70"),
									h.Style({ width: `${share * 100}%` }),
								]),
							],
						),
					],
				)
			}),
	]
}

export const pathsTooltip = (h: H, inputs: PathsTooltipInputs): Html => {
	const { node, anchor, width, height, reverse } = inputs
	return h.div(
		[
			h.Class("pointer-events-none absolute z-10 rounded-lg border bg-popover px-2.5 py-2 text-2xs shadow-md"),
			h.Style({
				left: `${Math.min(Math.max(0, node.x + NODE_W + 10), Math.max(0, width - TIP_W))}px`,
				top: `${Math.min(node.y + 4, Math.max(0, height - 96))}px`,
				width: `${TIP_W}px`,
			}),
			h.DataAttribute("slot", "paths-tooltip"),
		],
		[
			h.div(
				[h.Class("mb-1.5 flex min-w-0 items-center gap-1.5")],
				[
					h.span([
						h.Class(
							cn(
								"size-2 shrink-0 rounded-xs",
								node.kind === "event" && "bg-chart-2",
								node.kind === "end" && "bg-foreground/20",
								node.kind === "other" && "bg-foreground/35",
							),
						),
					]),
					h.span([h.Class("truncate font-medium text-foreground")], [labelOf(node)]),
					badge(h, { variant: "muted", size: "xs" }, [
						node.column === 0 ? "anchor" : reverse ? `${node.column} before` : `step ${node.column}`,
					]),
				],
			),
			h.div(
				[h.Class("mb-1.5 h-1.5 overflow-hidden rounded-sm bg-foreground/5")],
				[
					h.div([
						h.Class("h-full rounded-sm bg-chart-2"),
						h.Style({ width: `${Math.min(100, (node.count / anchor.count) * 100)}%` }),
					]),
				],
			),
			h.div(
				[h.Class("flex items-center justify-between gap-3 tabular-nums")],
				[
					h.span(
						[h.Class("flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground")],
						[icon(h, "UserIcon", { size: 12 }), node.column === 0 ? "started here" : "reached"],
					),
					h.span(
						[h.Class("flex items-baseline gap-1.5 whitespace-nowrap")],
						[
							h.span([h.Class("font-semibold text-foreground")], [node.count.toLocaleString("en-US")]),
							h.span(
								[h.Class("text-3xs whitespace-nowrap text-muted-foreground")],
								[`${formatPercent(node.count / anchor.count)} of anchor`],
							),
						],
					),
				],
			),
			...(node.column > 0 ? cameFrom(h, inputs) : []),
		],
	)
}
