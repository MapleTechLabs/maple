import { getViewportForBounds } from "@xyflow/system"
import type { PlacedNode, Rect, Viewport } from "./geometry"

/** `getInternalNodesBounds` over measured nodes; unmeasured nodes are left out, as in React Flow. */
export const measuredBounds = (nodes: ReadonlyArray<PlacedNode>): Rect | undefined => {
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY
	for (const node of nodes) {
		if (node.measured === undefined) continue
		minX = Math.min(minX, node.position.x)
		minY = Math.min(minY, node.position.y)
		maxX = Math.max(maxX, node.position.x + node.measured.width)
		maxY = Math.max(maxY, node.position.y + node.measured.height)
	}
	return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : undefined
}

export interface FitOptions {
	readonly padding: number
	readonly minZoom: number
	readonly maxZoom: number
}

/** `fitViewport`: the camera that frames every measured node in a `width` x `height` pane. */
export const fitViewport = (
	nodes: ReadonlyArray<PlacedNode>,
	pane: { readonly width: number; readonly height: number },
	options: FitOptions,
): Viewport | undefined => {
	const bounds = measuredBounds(nodes)
	if (bounds === undefined) return undefined
	return getViewportForBounds(
		bounds,
		pane.width,
		pane.height,
		options.minZoom,
		options.maxZoom,
		options.padding,
	)
}

/** d3-zoom `scaleBy` around the pane centre (React Flow's `zoomIn` / `zoomOut`, factor 1.2). */
export const scaleViewport = (
	viewport: Viewport,
	factor: number,
	pane: { readonly width: number; readonly height: number },
	limits: { readonly minZoom: number; readonly maxZoom: number },
): Viewport => {
	const zoom = Math.max(limits.minZoom, Math.min(limits.maxZoom, viewport.zoom * factor))
	const cx = pane.width / 2
	const cy = pane.height / 2
	const flowX = (cx - viewport.x) / viewport.zoom
	const flowY = (cy - viewport.y) / viewport.zoom
	return { x: cx - flowX * zoom, y: cy - flowY * zoom, zoom }
}

/** The viewport element's transform, exactly as React Flow writes it. */
export const viewportTransform = (viewport: Viewport): string =>
	`translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`

/** Whether a flow-space rect intersects the visible pane (`onlyRenderVisibleElements`). */
export const isRectVisible = (
	rect: Rect,
	viewport: Viewport,
	pane: { readonly width: number; readonly height: number },
): boolean => {
	const left = -viewport.x / viewport.zoom
	const top = -viewport.y / viewport.zoom
	const right = left + pane.width / viewport.zoom
	const bottom = top + pane.height / viewport.zoom
	return rect.x < right && rect.x + rect.width > left && rect.y < bottom && rect.y + rect.height > top
}
