import type { ProfileNode } from "./profile-tree"

// The flame chart's geometry: where each frame sits on a 0..1 axis (its share of the profile), the
// window onto that axis the chart is zoomed to, and what is under a point. No DOM in here.

/** A frame placed on the axis: `x0`..`x1` is its share of the whole profile, left-heavy. */
export interface FlameNode {
	readonly node: ProfileNode
	readonly x0: number
	readonly x1: number
	readonly parent: FlameNode | null
	readonly children: ReadonlyArray<FlameNode>
}

export interface FlameLayout {
	readonly root: FlameNode
	readonly byId: ReadonlyMap<string, FlameNode>
	/** Rows the chart needs: the deepest frame's depth, plus the root's row. */
	readonly rows: number
}

const layouts = new WeakMap<ProfileNode, FlameLayout>()

/** Every frame's extent, each child starting where its heavier sibling ended. */
export const layoutFlame = (root: ProfileNode): FlameLayout => {
	const cached = layouts.get(root)
	if (cached !== undefined) return cached
	const byId = new Map<string, FlameNode>()
	let rows = 1
	const place = (node: ProfileNode, x0: number, parent: FlameNode | null): FlameNode => {
		const children: Array<FlameNode> = []
		const placed: FlameNode = {
			node,
			x0,
			x1: x0 + (root.total === 0 ? 0 : node.total / root.total),
			parent,
			children,
		}
		byId.set(node.id, placed)
		rows = Math.max(rows, node.depth + 1)
		let offset = x0
		for (const child of node.children) {
			const next = place(child, offset, placed)
			children.push(next)
			offset = next.x1
		}
		return placed
	}
	const layout: FlameLayout = { root: place(root, 0, null), byId, rows }
	layouts.set(root, layout)
	return layout
}

// A plain loop: this runs on every pointer move, and an Option per row would be garbage.
const childAt = (frame: FlameNode, x: number): FlameNode | undefined => {
	for (const child of frame.children) if (x >= child.x0 && x < child.x1) return child
	return undefined
}

/** The frame on row `depth` under axis position `x`, if one is there. */
export const flameNodeAt = (layout: FlameLayout, x: number, depth: number): FlameNode | undefined => {
	if (depth < 0 || x < 0 || x > 1) return undefined
	let current = layout.root
	while (current.node.depth < depth) {
		const next = childAt(current, x)
		if (next === undefined) return undefined
		current = next
	}
	return x >= current.x0 && x <= current.x1 ? current : undefined
}

/** The window onto the axis: `start`..`end`, both within 0..1. */
export interface FlameViewport {
	readonly start: number
	readonly end: number
}

export const FULL_VIEWPORT: FlameViewport = { start: 0, end: 1 }

/** The narrowest window: a frame a millionth of the profile wide can still fill the chart. */
export const MIN_VIEWPORT_SPAN = 1e-6

/** Keeps a window inside the axis and no narrower than the floor, preserving its width where it can. */
export const clampViewport = (viewport: FlameViewport): FlameViewport => {
	const span = Math.min(1, Math.max(MIN_VIEWPORT_SPAN, viewport.end - viewport.start))
	const start = Math.min(1 - span, Math.max(0, viewport.start))
	return { start, end: start + span }
}

/** Scales the window by `factor` (under 1 zooms in) keeping axis position `anchor` where it is on screen. */
export const zoomViewport = (viewport: FlameViewport, anchor: number, factor: number): FlameViewport => {
	const span = viewport.end - viewport.start
	const nextSpan = Math.min(1, Math.max(MIN_VIEWPORT_SPAN, span * factor))
	const start = anchor - (anchor - viewport.start) * (nextSpan / span)
	return clampViewport({ start, end: start + nextSpan })
}

/** Slides the window by `delta` of the axis. */
export const panViewport = (viewport: FlameViewport, delta: number): FlameViewport =>
	clampViewport({ start: viewport.start + delta, end: viewport.end + delta })

/** The window that fits one frame edge to edge. */
export const viewportOf = (frame: Pick<FlameNode, "x0" | "x1">): FlameViewport =>
	clampViewport({ start: frame.x0, end: frame.x1 })

export const isZoomed = (viewport: FlameViewport): boolean => viewport.end - viewport.start < 1 - 1e-9

/** Axis position to a pixel offset in a chart `width` wide. */
export const toPixel = (viewport: FlameViewport, x: number, width: number): number =>
	((x - viewport.start) / (viewport.end - viewport.start)) * width

/** A pixel offset back to its axis position. */
export const toAxis = (viewport: FlameViewport, pixel: number, width: number): number =>
	viewport.start + (width === 0 ? 0 : pixel / width) * (viewport.end - viewport.start)

/** Where a keyboard zoom holds still: under the pointer while it is over the chart, else mid-window. */
export const zoomAnchor = (viewport: FlameViewport, pointerX: number | undefined, width: number): number =>
	pointerX === undefined ? (viewport.start + viewport.end) / 2 : toAxis(viewport, pointerX, width)

/** What a reader has of a chart: the window onto the axis and how far down the rows are scrolled. */
export interface FlameView {
	readonly viewport: FlameViewport
	readonly scrollY: number
}

/**
 * The view a chart gives a new tree. A refetch of the same view keeps the reader's zoom and scroll,
 * the scroll within the new content; another view starts on the whole profile from the top.
 */
export const viewForNewRoot = (current: FlameView, isSameView: boolean, maxScroll: number): FlameView =>
	isSameView
		? {
				viewport: clampViewport(current.viewport),
				scrollY: Math.min(Math.max(0, maxScroll), Math.max(0, current.scrollY)),
			}
		: { viewport: FULL_VIEWPORT, scrollY: 0 }

/**
 * Round steps (1, 2 or 5 times a power of ten) for a ruler over `span` units, about `target` of
 * them. The ruler measures width from the window's left edge, so the first tick is always zero.
 */
export const rulerStep = (span: number, target: number): number => {
	if (!(span > 0) || target <= 0) return 0
	const rough = span / target
	const magnitude = 10 ** Math.floor(Math.log10(rough))
	// The smallest round step that is not finer than asked; the epsilon absorbs float noise.
	const scaled = rough / magnitude - 1e-9
	return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude
}

/** Where arrow keys move a selection: to the caller, the heaviest callee, or a sibling. */
export const neighbour = (
	frame: FlameNode,
	direction: "up" | "down" | "left" | "right",
): FlameNode | undefined => {
	if (direction === "up") return frame.parent ?? undefined
	if (direction === "down") return frame.children[0]
	const siblings = frame.parent?.children ?? []
	const index = siblings.indexOf(frame)
	return siblings[direction === "left" ? index - 1 : index + 1]
}

/** Where the keyboard starts with nothing selected: the heaviest frame under the root, else the root. */
export const startFrame = (layout: FlameLayout): FlameNode => {
	let heaviest = layout.root
	let weight = -1
	for (const child of layout.root.children) {
		if (child.node.total > weight) {
			heaviest = child
			weight = child.node.total
		}
	}
	return heaviest
}
