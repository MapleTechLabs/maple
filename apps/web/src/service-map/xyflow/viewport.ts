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
	/** The smallest zoom a fit may pick: below it labels stop being legible, so the fit pans instead. */
	readonly readableZoom?: number
}

/** Below this a whole-graph fit is too small to read; a larger graph opens at the readable zoom. */
const FIT_ALL_FLOOR = 0.5

/**
 * A fit held at `zoom`: an axis that fits is centred, one that overflows starts at its padded
 * leading edge (the roots on the left, the top row on top), and the rest is a pan away.
 */
const readableViewport = (
	bounds: Rect,
	pane: { readonly width: number; readonly height: number },
	zoom: number,
	padding: number,
): Viewport => {
	const place = (start: number, size: number, paneSize: number) => {
		const scaled = size * zoom
		return scaled <= paneSize ? (paneSize - scaled) / 2 - start * zoom : paneSize * padding - start * zoom
	}
	return {
		x: place(bounds.x, bounds.width, pane.width),
		y: place(bounds.y, bounds.height, pane.height),
		zoom,
	}
}

/** Whether a measured card straddles the pane's right or bottom edge (cut mid-card). */
const cropsCard = (
	nodes: ReadonlyArray<PlacedNode>,
	viewport: Viewport,
	pane: { readonly width: number; readonly height: number },
): boolean =>
	nodes.some((node) => {
		if (node.measured === undefined) return false
		const left = node.position.x * viewport.zoom + viewport.x
		const top = node.position.y * viewport.zoom + viewport.y
		const right = left + node.measured.width * viewport.zoom
		const bottom = top + node.measured.height * viewport.zoom
		return (left < pane.width && right > pane.width) || (top < pane.height && bottom > pane.height)
	})

/** Zooms tried around the readable zoom, nearest first, so the far edges fall between cards. */
const nearbyZooms = (zoom: number): ReadonlyArray<number> =>
	Array.from({ length: 30 }, (_, i) => {
		const step = Math.floor(i / 2) + 1
		return zoom * (1 + (i % 2 === 0 ? -1 : 1) * step * 0.01)
	}).filter((candidate) => candidate >= FIT_ALL_FLOOR)

/** `fitViewport`: the camera that frames every measured node in a `width` x `height` pane. */
export const fitViewport = (
	nodes: ReadonlyArray<PlacedNode>,
	pane: { readonly width: number; readonly height: number },
	options: FitOptions,
): Viewport | undefined => {
	const bounds = measuredBounds(nodes)
	if (bounds === undefined) return undefined
	const fit = getViewportForBounds(
		bounds,
		pane.width,
		pane.height,
		options.minZoom,
		options.maxZoom,
		options.padding,
	)
	const readable = options.readableZoom
	if (readable === undefined || fit.zoom >= Math.min(readable, FIT_ALL_FLOOR)) return fit
	const padding = options.padding / 2
	const first = readableViewport(bounds, pane, readable, padding)
	if (!cropsCard(nodes, first, pane)) return first
	const clean = nearbyZooms(readable)
		.map((zoom) => readableViewport(bounds, pane, zoom, padding))
		.find((viewport) => !cropsCard(nodes, viewport, pane))
	return clean ?? first
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
