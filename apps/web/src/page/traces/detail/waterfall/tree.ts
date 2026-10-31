import type { SpanNodeData } from "../trace-data"

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
export const flattenTree = (
	nodes: ReadonlyArray<SpanNodeData>,
	expanded: ReadonlySet<string>,
	rails: ReadonlyArray<boolean> = [],
	parent: SpanNodeData | null = null,
): ReadonlyArray<TreeRow> =>
	nodes.flatMap((node, index) => {
		const isLast = index === nodes.length - 1
		return [
			{ node, rails, isLast, parent },
			...(expanded.has(node.spanId) && node.children.length > 0
				? flattenTree(node.children, expanded, parent === null ? [] : [...rails, !isLast], node)
				: []),
		]
	})

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
