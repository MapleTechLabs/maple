import { describe, expect, it } from "vitest"
import type { PlacedNode, Viewport } from "./geometry"
import { fitViewport } from "./viewport"

const card = (id: string, x: number, y: number): PlacedNode => ({
	id,
	position: { x, y },
	measured: { id, width: 270, height: 56, handles: [] },
})

const row = (count: number, gap: number): ReadonlyArray<PlacedNode> =>
	Array.from({ length: count }, (_, i) => card(`n${i}`, i * (270 + gap), 0))

const pane = { width: 1200, height: 700 }
const options = { padding: 0.2, minZoom: 0.1, maxZoom: 1.5, readableZoom: 0.7 }

const screenX = (node: PlacedNode, viewport: Viewport) => node.position.x * viewport.zoom + viewport.x

describe("fitViewport with a readable floor", () => {
	it("fits the whole graph when it stays legible", () => {
		const nodes = row(4, 80)
		const viewport = fitViewport(nodes, pane, options)
		expect(viewport).toBeDefined()
		if (viewport === undefined) return
		nodes.forEach((node) => {
			expect(screenX(node, viewport)).toBeGreaterThanOrEqual(0)
			expect(screenX(node, viewport) + 270 * viewport.zoom).toBeLessThanOrEqual(pane.width)
		})
	})

	const cutAtRightEdge = (nodes: ReadonlyArray<PlacedNode>, viewport: Viewport) =>
		nodes.filter((node) => {
			const left = screenX(node, viewport)
			return left < pane.width && left + 270 * viewport.zoom > pane.width
		})
	const isOnScreen = (node: PlacedNode, viewport: Viewport) =>
		screenX(node, viewport) >= 0 && screenX(node, viewport) + 270 * viewport.zoom <= pane.width

	it("opens a wide graph on the bulk of its nodes, not a corner", () => {
		const nodes = row(21, 80)
		const viewport = fitViewport(nodes, pane, options)
		expect(viewport).toBeDefined()
		if (viewport === undefined) return
		expect(viewport.zoom).toBeGreaterThanOrEqual(0.5)
		expect(isOnScreen(nodes[10] ?? card("x", 0, 0), viewport)).toBe(true)
		expect(isOnScreen(nodes[0] ?? card("x", 0, 0), viewport)).toBe(false)
		expect(cutAtRightEdge(nodes, viewport)).toEqual([])
	})

	it("keeps the focus node on screen, and never pans past the graph's first card", () => {
		const nodes = row(20, 80)
		const nearStart = fitViewport(nodes, pane, { ...options, focusNodeId: "n1" })
		const nearEnd = fitViewport(nodes, pane, { ...options, focusNodeId: "n16" })
		expect(nearStart).toBeDefined()
		expect(nearEnd).toBeDefined()
		if (nearStart === undefined || nearEnd === undefined) return
		expect(isOnScreen(nodes[1] ?? card("x", 0, 0), nearStart)).toBe(true)
		expect(screenX(nodes[0] ?? card("x", 0, 0), nearStart)).toBeGreaterThan(0)
		expect(isOnScreen(nodes[16] ?? card("x", 0, 0), nearEnd)).toBe(true)
	})

	it("frames every node when no readable floor is asked for", () => {
		const nodes = row(20, 80)
		const viewport = fitViewport(nodes, pane, { padding: 0.2, minZoom: 0.1, maxZoom: 1.5 })
		expect(viewport).toBeDefined()
		if (viewport === undefined) return
		nodes.forEach((node) => expect(isOnScreen(node, viewport)).toBe(true))
	})
})
