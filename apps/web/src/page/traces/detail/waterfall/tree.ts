import type { SpanNodeData } from "../trace-data"

// Pure tree walks over the Model's span tree for `SpanHierarchy`.

/** `flattenVisible`: the ordered rows whose every ancestor is expanded. */
export const flattenVisible = (
	nodes: ReadonlyArray<SpanNodeData>,
	expanded: ReadonlySet<string>,
): ReadonlyArray<SpanNodeData> =>
	nodes.flatMap((node) => [
		node,
		...(expanded.has(node.spanId) && node.children.length > 0
			? flattenVisible(node.children, expanded)
			: []),
	])

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
