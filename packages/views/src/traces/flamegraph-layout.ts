import { spanStartMs } from "@maple/ui/lib/span-tree"
import type { SpanNode } from "@maple/ui/lib/types"

// The bar geometry of `Flamegraph` and `FlamegraphMinimap` (packages/ui `traces/flamegraph*.tsx`).

export interface FlamegraphInput {
	readonly rootSpans: ReadonlyArray<SpanNode>
	readonly totalDurationMs: number
	readonly traceStartTime: string
	readonly services: ReadonlyArray<string>
}

export interface FlamegraphBar {
	readonly span: SpanNode
	readonly depth: number
	readonly lane: number
	readonly leftPercent: number
	readonly widthPercent: number
}

const walk = (node: SpanNode, visit: (node: SpanNode) => void): void => {
	visit(node)
	node.children.forEach((child) => walk(child, visit))
}

/** Bars relative to the focused span (or the whole trace), one lane per depth before packing. */
const barsOf = (input: FlamegraphInput, focused: SpanNode | undefined): ReadonlyArray<FlamegraphBar> => {
	const refStartMs = focused === undefined ? new Date(input.traceStartTime).getTime() : spanStartMs(focused)
	const refDurationMs = focused === undefined ? input.totalDurationMs : focused.durationMs
	const bars: Array<FlamegraphBar> = []
	const visit = (node: SpanNode): void => {
		const leftPercent = ((spanStartMs(node) - refStartMs) / refDurationMs) * 100
		const widthPercent = (node.durationMs / refDurationMs) * 100
		if (leftPercent + widthPercent < 0 || leftPercent > 100) return
		const depth = focused === undefined ? node.depth : node.depth - focused.depth
		const left = Math.max(0, leftPercent)
		bars.push({
			span: node,
			depth,
			lane: depth,
			leftPercent: left,
			widthPercent: Math.min(widthPercent, 100 - left),
		})
		node.children.forEach(visit)
	}
	if (focused === undefined) input.rootSpans.forEach(visit)
	else visit(focused)
	return bars
}

/** Packs each depth's bars into as few lanes as they fit, depth after depth. */
const packLanes = (
	bars: ReadonlyArray<FlamegraphBar>,
): { bars: ReadonlyArray<FlamegraphBar>; totalLanes: number } => {
	const depths = [...new Set(bars.map((bar) => bar.depth))].sort((a, b) => a - b)
	const packed: Array<FlamegraphBar> = []
	let laneOffset = 0
	depths.forEach((depth) => {
		const lanes: Array<number> = []
		const group = bars.filter((bar) => bar.depth === depth).sort((a, b) => a.leftPercent - b.leftPercent)
		group.forEach((bar) => {
			const free = lanes.findIndex((end) => bar.leftPercent >= end)
			const index = free === -1 ? lanes.length : free
			lanes[index] = bar.leftPercent + bar.widthPercent
			packed.push({ ...bar, lane: laneOffset + index })
		})
		laneOffset += lanes.length
	})
	return { bars: packed, totalLanes: laneOffset }
}

export interface FlamegraphLayout {
	readonly bars: ReadonlyArray<FlamegraphBar>
	readonly totalLanes: number
}

// Hovers and minimap drags re-render without changing the layout: one per trace and zoom.
const layouts = new WeakMap<FlamegraphInput, Map<string, FlamegraphLayout>>()
const minimaps = new WeakMap<FlamegraphInput, MinimapLayout>()

export const flamegraphBars = (input: FlamegraphInput, focused: SpanNode | undefined): FlamegraphLayout => {
	const byFocus = layouts.get(input) ?? new Map<string, FlamegraphLayout>()
	layouts.set(input, byFocus)
	const key = focused?.spanId ?? ""
	const cached = byFocus.get(key)
	if (cached !== undefined) return cached
	const layout = packLanes(barsOf(input, focused))
	byFocus.set(key, layout)
	return layout
}

export interface MinimapBar {
	readonly span: SpanNode
	readonly depth: number
	readonly leftPercent: number
	readonly widthPercent: number
}

export interface MinimapLayout {
	readonly bars: ReadonlyArray<MinimapBar>
	readonly maxDepth: number
}

/** Every span over the whole trace, at its tree depth. */
export const minimapBars = (input: FlamegraphInput): MinimapLayout => {
	const cached = minimaps.get(input)
	if (cached !== undefined) return cached
	const traceStartMs = new Date(input.traceStartTime).getTime()
	const bars: Array<MinimapBar> = []
	input.rootSpans.forEach((root) =>
		walk(root, (node) => {
			const leftPercent = Math.max(
				0,
				((spanStartMs(node) - traceStartMs) / input.totalDurationMs) * 100,
			)
			const widthPercent = (node.durationMs / input.totalDurationMs) * 100
			bars.push({
				span: node,
				depth: node.depth,
				leftPercent,
				widthPercent: Math.min(widthPercent, 100 - leftPercent),
			})
		}),
	)
	const layout = { bars, maxDepth: bars.reduce((max, bar) => Math.max(max, bar.depth), 0) }
	minimaps.set(input, layout)
	return layout
}

/** The deepest span under a point of the minimap, as a percent of the trace. */
export const spanAtMinimapPercent = (input: FlamegraphInput, percent: number): SpanNode | undefined =>
	minimapBars(input)
		.bars.filter((bar) => percent >= bar.leftPercent && percent <= bar.leftPercent + bar.widthPercent)
		.reduce<MinimapBar | undefined>(
			(deepest, bar) => (deepest === undefined || bar.depth > deepest.depth ? bar : deepest),
			undefined,
		)?.span
