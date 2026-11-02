import type { SpanNodeData } from "@maple/views/traces/trace-data"

// Pure tree walks over the Model's span tree for `SpanHierarchy`.

/** A visible row and what its tree connectors need: which ancestor rails continue past it. */
export type TreeRow = Readonly<{
	node: SpanNodeData
	/** One per ancestor column above the parent's: true where that ancestor has later siblings. */
	rails: ReadonlyArray<boolean>
	isLast: boolean
	parent: SpanNodeData | null
}>

/** The ordered rows whose every ancestor is expanded. */
const flattenTree = (
	nodes: ReadonlyArray<SpanNodeData>,
	expanded: ReadonlySet<string>,
): ReadonlyArray<TreeRow> => {
	const rows: Array<TreeRow> = []
	const visit = (
		siblings: ReadonlyArray<SpanNodeData>,
		rails: ReadonlyArray<boolean>,
		parent: SpanNodeData | null,
	): void =>
		siblings.forEach((node, index) => {
			const isLast = index === siblings.length - 1
			rows.push({ node, rails, isLast, parent })
			if (expanded.has(node.spanId) && node.children.length > 0)
				visit(node.children, parent === null ? [] : [...rails, !isLast], node)
		})
	visit(nodes, [], null)
	return rows
}

/** The visible rows plus what the view reads off them, recomputed only when the tree or expansion change. */
export type FlatTree = Readonly<{
	rows: ReadonlyArray<TreeRow>
	expanded: ReadonlySet<string>
	keys: string
}>

const flatCache = new WeakMap<ReadonlyArray<SpanNodeData>, { ids: ReadonlyArray<string>; flat: FlatTree }>()

export const flatTreeOf = (
	rootSpans: ReadonlyArray<SpanNodeData>,
	expandedIds: ReadonlyArray<string>,
): FlatTree => {
	const cached = flatCache.get(rootSpans)
	if (cached !== undefined && cached.ids === expandedIds) return cached.flat
	const expanded = new Set(expandedIds)
	const rows = flattenTree(rootSpans, expanded)
	const flat = { rows, expanded, keys: rows.map((row) => row.node.spanId).join(" ") }
	flatCache.set(rootSpans, { ids: expandedIds, flat })
	return flat
}

/** A row's column in the tree: 0 for roots. */
export const treeLevel = (row: TreeRow): number => (row.parent === null ? 0 : row.rails.length + 1)

/** Every span in the tree, the header's "N of total". */
export const countSpans = (nodes: ReadonlyArray<SpanNodeData>): number =>
	nodes.reduce((sum, node) => sum + 1 + countSpans(node.children), 0)

/** `countDescendants` for the collapsed `+N` badge. */
export const countDescendants = (node: SpanNodeData): number => countSpans(node.children)

// copied: `collectParentIdsByLevel` (use-trace-timeline.ts is a React module).
export const collectParentIdsByLevel = (rootSpans: ReadonlyArray<SpanNodeData>): Map<number, Set<string>> => {
	const byLevel = new Map<number, Set<string>>()
	const visit = (node: SpanNodeData): void => {
		if (node.children.length === 0) return
		const level = byLevel.get(node.depth) ?? new Set<string>()
		level.add(node.spanId)
		byLevel.set(node.depth, level)
		node.children.forEach(visit)
	}
	rootSpans.forEach(visit)
	return byLevel
}
