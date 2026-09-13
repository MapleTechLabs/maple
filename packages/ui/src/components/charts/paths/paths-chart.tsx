import * as React from "react"

import type { PathsChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber } from "../../../lib/format"
import { asFiniteNumber } from "../_shared/breakdown-rows"
import { useContainerSize } from "../../../hooks/use-container-size"

// Paths: a column-wise flow out of (or into) one anchor.
//
// Rows are hops, `{ hop, fromNode, toNode, count }`: column 0 is the anchor,
// column k the nodes reached in k hops. Two sentinels arrive from the query
// and are drawn as neutral terminals rather than events: `''` (the sequence
// ended) and `$other` (the column's folded remainder). One hue carries every
// flow — the identity is in the label, never the colour — so the chart has no
// legend to keep honest; hovering a node lifts the flows through it.

const OTHER = "$other"
const ENDED = ""

type NodeKind = "event" | "other" | "end"

interface PathNode {
	id: string
	column: number
	name: string
	count: number
	kind: NodeKind
}

interface PathLink {
	source: string
	target: string
	count: number
}

interface Layout {
	nodes: Map<string, PathNode & { x: number; y: number; h: number }>
	links: Array<PathLink & { sy: number; ty: number; h: number; x0: number; x1: number }>
	columns: number[]
}

const NODE_W = 10
const NODE_GAP = 8
/** A node this tall carries its count on a second line instead of after the name. */
const TWO_LINE_H = 26

/**
 * Labels sit over the ribbons, so they wear a halo in the card colour: the text
 * stays legible where two flows cross behind it, and a name can run further
 * into the span than a bare label safely could.
 */
const HALO: React.CSSProperties = {
	paintOrder: "stroke",
	stroke: "var(--card)",
	strokeWidth: 3,
	strokeLinejoin: "round",
}
const HEADER_H = 18
/** Breathing room under the lowest node, so a terminal never touches the card edge. */
const FOOTER_H = 4
const CHAR_W = 6.6
const TIP_W = 250

const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

function kindOf(name: string): NodeKind {
	return name === ENDED ? "end" : name === OTHER ? "other" : "event"
}

function labelOf(node: PathNode): string {
	return node.kind === "end" ? "Ended" : node.kind === "other" ? "Other" : node.name
}

const KIND_RANK = { event: 0, other: 1, end: 2 } satisfies Record<NodeKind, number>

/** Rows → nodes and links. Column 0 holds the anchor alone. */
function toGraph(source: ReadonlyArray<Record<string, unknown>>): { nodes: PathNode[]; links: PathLink[] } {
	const nodes = new Map<string, PathNode>()
	const links: PathLink[] = []
	const nodeId = (column: number, name: string) => `${column}:${name}`
	const touch = (column: number, name: string, count: number) => {
		const id = nodeId(column, name)
		const node = nodes.get(id)
		if (node) node.count += count
		else nodes.set(id, { id, column, name, count, kind: kindOf(name) })
	}
	for (const row of source) {
		const hop = asFiniteNumber(row.hop)
		const count = asFiniteNumber(row.count)
		if (hop < 1 || count <= 0) continue
		const from = typeof row.fromNode === "string" ? row.fromNode : ""
		const to = typeof row.toNode === "string" ? row.toNode : ""
		// A node's count is what ARRIVES at it; the anchor's is what leaves it.
		if (hop === 1) touch(0, from, count)
		touch(hop, to, count)
		links.push({ source: nodeId(hop - 1, from), target: nodeId(hop, to), count })
	}
	return { nodes: [...nodes.values()], links }
}

function layout(
	nodes: PathNode[],
	links: PathLink[],
	width: number,
	height: number,
	reverse: boolean,
): Layout {
	const columns = [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b)
	const columnX = (column: number): number => {
		const index = columns.indexOf(column)
		const x = columns.length === 1 ? 0 : (index * (width - NODE_W)) / (columns.length - 1)
		return reverse ? width - NODE_W - x : x
	}
	const maxTotal = Math.max(
		1,
		...columns.map((column) =>
			nodes.filter((node) => node.column === column).reduce((acc, node) => acc + node.count, 0),
		),
	)
	const maxNodes = Math.max(
		1,
		...columns.map((column) => nodes.filter((node) => node.column === column).length),
	)
	const plotH = Math.max(0, height - HEADER_H - FOOTER_H - NODE_GAP * (maxNodes - 1))
	const scale = plotH / maxTotal

	const placed = new Map<string, PathNode & { x: number; y: number; h: number }>()
	for (const column of columns) {
		const ordered = nodes
			.filter((node) => node.column === column)
			.sort(
				(a, b) =>
					KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
					b.count - a.count ||
					a.name.localeCompare(b.name),
			)
		let y = HEADER_H
		for (const node of ordered) {
			const h = Math.max(2, node.count * scale)
			placed.set(node.id, { ...node, x: columnX(column), y, h })
			y += h + NODE_GAP
		}
	}

	// Ribbons leave a node in target order and enter it in source order, so
	// they never cross inside a column.
	const outOffset = new Map<string, number>()
	const inOffset = new Map<string, number>()
	const bySource = [...links].sort((a, b) => {
		const ay = placed.get(a.target)?.y ?? 0
		const by = placed.get(b.target)?.y ?? 0
		return (placed.get(a.source)?.y ?? 0) - (placed.get(b.source)?.y ?? 0) || ay - by
	})
	const withSy = bySource.map((link) => {
		const source = placed.get(link.source)
		const h = link.count * scale
		const sy = (source?.y ?? 0) + (outOffset.get(link.source) ?? 0)
		outOffset.set(link.source, (outOffset.get(link.source) ?? 0) + h)
		return { ...link, sy, h }
	})
	const byTarget = [...withSy].sort((a, b) => {
		return (
			(placed.get(a.target)?.y ?? 0) - (placed.get(b.target)?.y ?? 0) ||
			(placed.get(a.source)?.y ?? 0) - (placed.get(b.source)?.y ?? 0)
		)
	})
	const laid = byTarget.map((link) => {
		const source = placed.get(link.source)
		const target = placed.get(link.target)
		const ty = (target?.y ?? 0) + (inOffset.get(link.target) ?? 0)
		inOffset.set(link.target, (inOffset.get(link.target) ?? 0) + link.h)
		const sx = source?.x ?? 0
		const tx = target?.x ?? 0
		return {
			...link,
			ty,
			x0: reverse ? sx : sx + NODE_W,
			x1: reverse ? tx + NODE_W : tx,
		}
	})
	return { nodes: placed, links: laid, columns }
}

function ribbon(x0: number, sy: number, x1: number, ty: number, h: number): string {
	const cx = (x0 + x1) / 2
	return `M${x0},${sy} C${cx},${sy} ${cx},${ty} ${x1},${ty} L${x1},${ty + h} C${cx},${ty + h} ${cx},${sy + h} ${x0},${sy + h} Z`
}

export function PathsChart({ data, className, direction = "after" }: PathsChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS
	const { nodes, links } = React.useMemo(() => toGraph(source), [source])
	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width, height } = useContainerSize(containerRef)
	const reverse = direction === "before"
	const [hover, setHover] = React.useState<string | null>(null)

	const graph = React.useMemo(
		() => (width > 0 && height > 0 ? layout(nodes, links, width, height, reverse) : undefined),
		[nodes, links, width, height, reverse],
	)

	const anchor = nodes.find((node) => node.column === 0)
	if (!anchor || anchor.count <= 0) {
		return (
			<div className={cn("relative grid h-full w-full place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	const columnSpan =
		graph && graph.columns.length > 1 ? (width - NODE_W) / (graph.columns.length - 1) : width
	// Two labels share every span (the left column's to the right of its node,
	// the right column's to the left of its). Their halos let each run a little
	// past the midpoint, since the two rarely sit on the same row. When the room
	// cannot hold a name AND a count, the count moves under the name on tall
	// nodes and into the tooltip on short ones.
	const roomChars = Math.floor((columnSpan * 0.7 - 20) / CHAR_W)
	const showCounts = roomChars >= 14
	const maxChars = Math.max(6, showCounts ? roomChars - 6 : roomChars)
	const truncate = (label: string) => (label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label)

	const hoveredNode = hover ? graph?.nodes.get(hover) : undefined
	const isLit = (link: PathLink) => hover !== null && (link.source === hover || link.target === hover)

	return (
		<div
			ref={containerRef}
			className={cn("relative h-full w-full select-none", className)}
			onPointerLeave={() => setHover(null)}
			data-slot="paths-chart"
		>
			{graph && (
				<svg viewBox={`0 0 ${width} ${height}`} className="block h-full w-full overflow-visible">
					{graph.columns.map((column, index) => {
						const last = index === graph.columns.length - 1
						const x =
							graph.nodes.get(
								[...graph.nodes.keys()].find((id) => id.startsWith(`${column}:`)) ?? "",
							)?.x ?? 0
						const anchorLabel = "Anchor"
						const label = column === 0 ? anchorLabel : reverse ? `−${column}` : `Step ${column}`
						// In a forward walk the first column is at the left edge and the
						// last at the right; reversed, the anchor sits at the right.
						const atRightEdge = reverse ? column === 0 : last
						return (
							<text
								key={column}
								x={atRightEdge ? x + NODE_W : x}
								y={10}
								textAnchor={atRightEdge ? "end" : "start"}
								className="fill-muted-foreground text-[10px] font-medium uppercase tracking-wider"
							>
								{label}
							</text>
						)
					})}
					{graph.links.map((link, index) => {
						const target = graph.nodes.get(link.target)
						const kind = target?.kind ?? "event"
						const lit = isLit(link)
						const dim = hover !== null && !lit
						return (
							<path
								key={`${link.source}->${link.target}-${index}`}
								d={ribbon(link.x0, link.sy, link.x1, link.ty, link.h)}
								// Ribbons never take the pointer: hover belongs to the nodes, and a
								// label sitting over a ribbon must still reach its node.
								className={cn(
									"pointer-events-none",
									kind === "event" && "fill-[var(--chart-2)]",
									kind === "end" && "fill-foreground",
									kind === "other" && "fill-foreground",
								)}
								style={{
									fillOpacity: dim
										? 0.05
										: kind === "event"
											? lit
												? 0.65
												: 0.2
											: kind === "end"
												? lit
													? 0.3
													: 0.07
												: lit
													? 0.4
													: 0.12,
									transition: "fill-opacity 140ms ease",
								}}
							/>
						)
					})}
					{[...graph.nodes.values()].map((node) => {
						const labelLeft = reverse ? node.column !== 0 : node.column === 0
						// Column 0 labels sit to the right of the node, every other column's
						// to the left, over the ribbons arriving there.
						const textX = labelLeft ? node.x + NODE_W + 6 : node.x - 6
						const dim =
							hover !== null &&
							hover !== node.id &&
							!links.some(
								(link) => isLit(link) && (link.source === node.id || link.target === node.id),
							)
						const showText = node.h >= 9 || node.kind !== "event"
						const twoLine = node.h >= TWO_LINE_H
						const countInline = showCounts && !twoLine
						const hitLabelW = showText
							? (truncate(labelOf(node)).length + (countInline ? 7 : 0)) * CHAR_W + 6
							: 0
						return (
							<g
								key={node.id}
								onPointerEnter={() => setHover(node.id)}
								style={{ opacity: dim ? 0.45 : 1, transition: "opacity 140ms ease" }}
								data-slot="paths-node"
							>
								<rect
									x={node.x}
									y={node.y}
									width={NODE_W}
									height={node.h}
									rx={2}
									className={cn(
										node.kind === "event" && "fill-[var(--chart-2)]",
										node.kind === "end" && "fill-foreground/20",
										node.kind === "other" && "fill-foreground/35",
									)}
								/>
								{/* The hit target spans the node AND its label, so hovering the
								    name lifts the flows too. */}
								<rect
									x={labelLeft ? node.x - 6 : node.x - 6 - hitLabelW}
									y={node.y - 2}
									width={NODE_W + 12 + hitLabelW}
									height={Math.max(node.h, 12) + 4}
									fill="transparent"
									data-slot="paths-node-hit"
								/>
								{showText && (
									<text
										x={textX}
										y={node.y + Math.min(node.h, 12) / 2 + 3.5}
										textAnchor={labelLeft ? "start" : "end"}
										className={cn(
											"text-[11px] font-medium",
											node.kind === "event"
												? "fill-foreground"
												: "fill-muted-foreground",
										)}
										style={HALO}
									>
										{truncate(labelOf(node))}
										{(countInline || twoLine) && (
											<>
												{" "}
												<tspan
													x={twoLine ? textX : undefined}
													dy={twoLine ? 13 : undefined}
													className="fill-muted-foreground text-[10px] font-normal tabular-nums"
												>
													{formatNumber(node.count)}
												</tspan>
											</>
										)}
									</text>
								)}
							</g>
						)
					})}
				</svg>
			)}
			{hoveredNode && graph && (
				<div
					className="pointer-events-none absolute z-10 rounded-lg border bg-popover px-2.5 py-2 text-[11px] shadow-md"
					style={{
						left: Math.min(Math.max(0, hoveredNode.x + NODE_W + 10), Math.max(0, width - TIP_W)),
						top: Math.min(hoveredNode.y + 4, Math.max(0, height - 96)),
						width: TIP_W,
					}}
					data-slot="paths-tooltip"
				>
					<div className="mb-1 truncate text-foreground/90">
						{labelOf(hoveredNode)}
						<span className="ml-1.5 text-muted-foreground">
							{hoveredNode.column === 0
								? "anchor"
								: reverse
									? `${hoveredNode.column} before`
									: `step ${hoveredNode.column}`}
						</span>
					</div>
					<div className="flex justify-between gap-3 tabular-nums">
						<span className="text-muted-foreground">
							{hoveredNode.column === 0 ? "started here" : "reached"}
						</span>
						<span className="text-foreground/90">
							{hoveredNode.count.toLocaleString("en-US")} ·{" "}
							{((hoveredNode.count / anchor.count) * 100).toFixed(
								hoveredNode.count / anchor.count < 0.1 ? 1 : 0,
							)}
							%
						</span>
					</div>
					{hoveredNode.column > 0 && (
						<div className="mt-1 text-[10px] text-muted-foreground">
							{links
								.filter((link) => link.target === hoveredNode.id)
								.sort((a, b) => b.count - a.count)
								.slice(0, 3)
								.map((link) => {
									const from = graph.nodes.get(link.source)
									return (
										<div
											key={link.source}
											className="flex justify-between gap-3 tabular-nums"
										>
											<span className="truncate">← {from ? labelOf(from) : ""}</span>
											<span>{link.count.toLocaleString("en-US")}</span>
										</div>
									)
								})}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
