import { asFiniteNumber } from "@maple/ui/components/charts/_shared/breakdown-rows"

// The graph and layout of `PathsChart` (packages/ui/src/components/charts/paths/paths-chart.tsx):
// rows are hops, column 0 is the anchor, `''` ended and `$other` the folded remainder.

const OTHER = "$other"
const ENDED = ""

export type NodeKind = "event" | "other" | "end"

export interface PathNode {
	readonly id: string
	readonly column: number
	readonly name: string
	readonly count: number
	readonly kind: NodeKind
}

export interface PathLink {
	readonly source: string
	readonly target: string
	readonly count: number
}

export type PlacedNode = PathNode & { readonly x: number; readonly y: number; readonly h: number }
export type PlacedLink = PathLink & {
	readonly sy: number
	readonly ty: number
	readonly h: number
	readonly x0: number
	readonly x1: number
}

export interface PathsLayout {
	readonly nodes: ReadonlyMap<string, PlacedNode>
	readonly links: ReadonlyArray<PlacedLink>
	readonly columns: ReadonlyArray<number>
}

export const NODE_W = 10
const NODE_GAP = 8
const HEADER_H = 18
const FOOTER_H = 4

const kindOf = (name: string): NodeKind => (name === ENDED ? "end" : name === OTHER ? "other" : "event")

export const labelOf = (node: PathNode): string =>
	node.kind === "end" ? "Ended" : node.kind === "other" ? "Other" : node.name

const KIND_RANK = { event: 0, other: 1, end: 2 } satisfies Record<NodeKind, number>

/** `toGraph`: rows into nodes and links. A node's count is what arrives; the anchor's what leaves. */
export const toGraph = (
	source: ReadonlyArray<Readonly<Record<string, unknown>>>,
): { nodes: ReadonlyArray<PathNode>; links: ReadonlyArray<PathLink> } => {
	const nodes = new Map<string, PathNode>()
	const links: Array<PathLink> = []
	const nodeId = (column: number, name: string) => `${column}:${name}`
	const touch = (column: number, name: string, count: number) => {
		const id = nodeId(column, name)
		const node = nodes.get(id)
		nodes.set(
			id,
			node === undefined
				? { id, column, name, count, kind: kindOf(name) }
				: { ...node, count: node.count + count },
		)
	}
	source.forEach((row) => {
		const hop = asFiniteNumber(row.hop)
		const count = asFiniteNumber(row.count)
		if (hop < 1 || count <= 0) return
		const from = typeof row.fromNode === "string" ? row.fromNode : ""
		const to = typeof row.toNode === "string" ? row.toNode : ""
		if (hop === 1) touch(0, from, count)
		touch(hop, to, count)
		links.push({ source: nodeId(hop - 1, from), target: nodeId(hop, to), count })
	})
	return { nodes: [...nodes.values()], links }
}

const placeNodes = (
	nodes: ReadonlyArray<PathNode>,
	columns: ReadonlyArray<number>,
	columnX: (column: number) => number,
	scale: number,
): Map<string, PlacedNode> => {
	const placed = new Map<string, PlacedNode>()
	columns.forEach((column) => {
		const ordered = nodes
			.filter((node) => node.column === column)
			.toSorted(
				(a, b) =>
					KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
					b.count - a.count ||
					a.name.localeCompare(b.name),
			)
		ordered.reduce((y, node) => {
			const h = Math.max(2, node.count * scale)
			placed.set(node.id, { ...node, x: columnX(column), y, h })
			return y + h + NODE_GAP
		}, HEADER_H)
	})
	return placed
}

/** `layout`: columns spread across the width, nodes stacked by kind then count, ribbons offset. */
export const layoutPaths = (
	nodes: ReadonlyArray<PathNode>,
	links: ReadonlyArray<PathLink>,
	width: number,
	height: number,
	reverse: boolean,
): PathsLayout => {
	const columns = [...new Set(nodes.map((node) => node.column))].toSorted((a, b) => a - b)
	const columnX = (column: number): number => {
		const index = columns.indexOf(column)
		const x = columns.length === 1 ? 0 : (index * (width - NODE_W)) / (columns.length - 1)
		return reverse ? width - NODE_W - x : x
	}
	const inColumn = (column: number) => nodes.filter((node) => node.column === column)
	const maxTotal = Math.max(
		1,
		...columns.map((column) => inColumn(column).reduce((acc, node) => acc + node.count, 0)),
	)
	const maxNodes = Math.max(1, ...columns.map((column) => inColumn(column).length))
	const plotH = Math.max(0, height - HEADER_H - FOOTER_H - NODE_GAP * (maxNodes - 1))
	const scale = plotH / maxTotal
	const placed = placeNodes(nodes, columns, columnX, scale)
	const yOf = (id: string) => placed.get(id)?.y ?? 0
	const outOffset = new Map<string, number>()
	const inOffset = new Map<string, number>()
	const withSy = links
		.toSorted((a, b) => yOf(a.source) - yOf(b.source) || yOf(a.target) - yOf(b.target))
		.map((link) => {
			const h = link.count * scale
			const sy = yOf(link.source) + (outOffset.get(link.source) ?? 0)
			outOffset.set(link.source, (outOffset.get(link.source) ?? 0) + h)
			return { ...link, sy, h }
		})
	const laid = withSy
		.toSorted((a, b) => yOf(a.target) - yOf(b.target) || yOf(a.source) - yOf(b.source))
		.map((link): PlacedLink => {
			const ty = yOf(link.target) + (inOffset.get(link.target) ?? 0)
			inOffset.set(link.target, (inOffset.get(link.target) ?? 0) + link.h)
			const sx = placed.get(link.source)?.x ?? 0
			const tx = placed.get(link.target)?.x ?? 0
			return { ...link, ty, x0: reverse ? sx : sx + NODE_W, x1: reverse ? tx + NODE_W : tx }
		})
	return { nodes: placed, links: laid, columns }
}

export const ribbon = (x0: number, sy: number, x1: number, ty: number, h: number): string => {
	const cx = (x0 + x1) / 2
	return `M${x0},${sy} C${cx},${sy} ${cx},${ty} ${x1},${ty} L${x1},${ty + h} C${cx},${ty + h} ${cx},${sy + h} ${x0},${sy + h} Z`
}
