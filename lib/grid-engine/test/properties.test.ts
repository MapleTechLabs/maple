import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	clampPosition,
	clampSize,
	collides,
	compact,
	moveItem,
	normalizeLayout,
	nudgeItem,
	resizeItem,
	sameLayout,
	type Layout,
} from "../src/index.ts"
import { CANONICAL_COLS, cleanLayoutArb, layoutArb, opArb, type Op } from "./arbitraries.ts"

// Invariants that hold for any board and any edit, independent of what
// react-grid-layout happened to do. These outlive the parity suite.

function overlaps(layout: Layout): boolean {
	return layout.some((a, index) => layout.slice(index + 1).some((b) => collides(a, b)))
}

function inBounds(layout: Layout, cols: number): boolean {
	return layout.every((item) => item.x >= 0 && item.y >= 0 && item.x + item.w <= cols)
}

/** Nothing could float up: every item rests on row 0 or on another item. */
function settled(layout: Layout): boolean {
	return layout.every(
		(item) =>
			item.y === 0 ||
			layout.some(
				(other) =>
					other.i !== item.i &&
					other.y + other.h === item.y &&
					other.x < item.x + item.w &&
					other.x + other.w > item.x,
			),
	)
}

const cols = CANONICAL_COLS
const normalized = layoutArb(cols).map((layout) => normalizeLayout(layout, cols, "vertical"))

/** Apply an op the way the canvas does: clamp, then step. */
function apply(layout: Layout, op: Op): Layout {
	const item = layout[op.pick % layout.length]!
	if (op.kind === "move") {
		const target = clampPosition(item, op.x, op.y, cols)
		return moveItem(layout, item.i, target.x, target.y)
	}
	const size = clampSize(item, op.w, op.h, cols)
	return resizeItem(layout, item.i, size.w, size.h)
}

describe("normalizeLayout", () => {
	it("draws any stored board without overlaps, inside the grid, fully packed", () => {
		fc.assert(
			fc.property(layoutArb(cols), (layout) => {
				const out = normalizeLayout(layout, cols, "vertical")
				expect(out.map((item) => item.i)).toEqual(layout.map((item) => item.i))
				expect(overlaps(out)).toBe(false)
				expect(settled(out)).toBe(true)
				// Clamping only fixes x; an item wider than the grid stays wide.
				expect(out.filter((item) => item.w <= cols).every((item) => item.x + item.w <= cols)).toBe(
					true,
				)
			}),
			{ numRuns: 3000 },
		)
	})

	it("is idempotent, and returns the same array when there is nothing to do", () => {
		fc.assert(
			fc.property(layoutArb(cols), (layout) => {
				const once = normalizeLayout(layout, cols, "vertical")
				expect(normalizeLayout(once, cols, "vertical")).toBe(once)
				expect(compact(once, "vertical")).toBe(once)
			}),
			{ numRuns: 2000 },
		)
	})

	it("never moves an in-bounds item down while packing", () => {
		fc.assert(
			fc.property(cleanLayoutArb(cols), (layout) => {
				const out = normalizeLayout(layout, cols, "vertical")
				// Overlapping inputs push items down to resolve the overlap; boards
				// without overlaps only ever float up.
				if (overlaps(layout)) return
				out.forEach((item, index) => expect(item.y).toBeLessThanOrEqual(layout[index]!.y))
			}),
			{ numRuns: 3000 },
		)
	})

	it("keeps the caller's objects for items that did not move", () => {
		fc.assert(
			fc.property(layoutArb(cols), (layout) => {
				const out = normalizeLayout(layout, cols, "vertical")
				out.forEach((item, index) => {
					const before = layout[index]!
					const unchanged =
						before.x === item.x &&
						before.y === item.y &&
						before.w === item.w &&
						before.h === item.h
					expect(item === before).toBe(unchanged)
				})
			}),
			{ numRuns: 2000 },
		)
	})

	it("leaves positions alone without compaction, beyond clamping into the grid", () => {
		fc.assert(
			fc.property(cleanLayoutArb(6), (layout) => {
				expect(normalizeLayout(layout, 6, "none")).toBe(layout)
			}),
		)
	})
})

describe("editing", () => {
	it("keeps the board overlap-free, in bounds and packed through any edit sequence", () => {
		fc.assert(
			fc.property(cleanLayoutArb(cols), fc.array(opArb(cols), { maxLength: 25 }), (input, ops) => {
				let layout = normalizeLayout(input, cols, "vertical")
				for (const op of ops) {
					layout = apply(layout, op)
					expect(overlaps(layout)).toBe(false)
					expect(inBounds(layout, cols)).toBe(true)
					expect(settled(layout)).toBe(true)
				}
			}),
			{ numRuns: 2000 },
		)
	})

	it("respects min/max sizes and the grid edge on resize", () => {
		fc.assert(
			fc.property(normalized, opArb(cols), (layout, op) => {
				if (layout.length === 0 || op.kind !== "resize") return
				const item = layout[op.pick % layout.length]!
				const { w, h } = clampSize(item, op.w, op.h, cols)
				expect(w).toBeGreaterThanOrEqual(item.minW ?? 1)
				expect(h).toBeGreaterThanOrEqual(item.minH ?? 1)
				if (item.maxW !== undefined)
					expect(w).toBeLessThanOrEqual(Math.max(item.maxW, item.minW ?? 1))
				if (item.maxH !== undefined)
					expect(h).toBeLessThanOrEqual(Math.max(item.maxH, item.minH ?? 1))
				if ((item.minW ?? 1) <= cols - item.x) expect(item.x + w).toBeLessThanOrEqual(cols)
			}),
			{ numRuns: 3000 },
		)
	})

	it("is a no-op to drop a tile back on its own cell", () => {
		fc.assert(
			fc.property(normalized, fc.nat(), (layout, pick) => {
				if (layout.length === 0) return
				const item = layout[pick % layout.length]!
				expect(moveItem(layout, item.i, item.x, item.y)).toBe(layout)
			}),
			{ numRuns: 2000 },
		)
	})

	// The canvas recomputes only when the pointer enters a new cell, where
	// react-grid-layout recomputed on every pointer event. That is only the same
	// thing if re-applying the step for the cell the pointer is still in changes
	// nothing.
	it("settles after one step, so recomputing per cell equals per pointer event", () => {
		fc.assert(
			fc.property(normalized, opArb(cols), (layout, op) => {
				if (layout.length === 0 || op.kind !== "move") return
				const item = layout[op.pick % layout.length]!
				const target = clampPosition(item, op.x, op.y, cols)
				const once = moveItem(layout, item.i, target.x, target.y)
				const twice = moveItem(once, item.i, target.x, target.y)
				expect(sameLayout(twice, once)).toBe(true)
			}),
			{ numRuns: 5000 },
		)
	})

	it("leaves the layout untouched for an unknown id", () => {
		fc.assert(
			fc.property(normalized, (layout) => {
				expect(moveItem(layout, "missing", 0, 0)).toBe(layout)
				expect(resizeItem(layout, "missing", 1, 1)).toBe(layout)
				expect(nudgeItem(layout, "missing", 1, 0, cols)).toBe(layout)
			}),
		)
	})
})

describe("nudgeItem", () => {
	it("always changes the board unless the tile is against the edge it moves toward", () => {
		fc.assert(
			fc.property(
				normalized,
				fc.nat(),
				fc.constantFrom([1, 0], [-1, 0], [0, 1], [0, -1]),
				(layout, pick, dir) => {
					if (layout.length === 0) return
					const [dx, dy] = dir as [-1 | 0 | 1, -1 | 0 | 1]
					const item = layout[pick % layout.length]!
					const next = nudgeItem(layout, item.i, dx, dy, cols)
					const atEdge =
						(dx === -1 && item.x === 0) ||
						(dx === 1 && item.x + item.w >= cols) ||
						(dy === -1 && item.y === 0)
					if (atEdge) expect(next).toBe(layout)
					expect(overlaps(next)).toBe(false)
					expect(settled(next)).toBe(true)
				},
			),
			{ numRuns: 3000 },
		)
	})

	it("moves a tile below its neighbour on ArrowDown even though one row is a no-op", () => {
		const layout: Layout = [
			{ i: "a", x: 0, y: 0, w: 6, h: 2 },
			{ i: "b", x: 0, y: 2, w: 6, h: 4 },
		]
		const next = nudgeItem(layout, "a", 0, 1, cols)
		expect(next.find((item) => item.i === "a")!.y).toBeGreaterThan(next.find((item) => item.i === "b")!.y)
	})
})
