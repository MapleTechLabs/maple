import fc from "fast-check"
import type { GridItem, Layout } from "../src/index.ts"

// Generators shared by the property and parity suites. Layouts are deliberately
// dirty: overlaps, holes, items hanging off the right edge and wider than the
// grid are all things stored dashboards contain (MCP writes, imports, older
// clients), and the grid has to draw them the same way regardless.

export const CANONICAL_COLS = 12

export const itemArb = (cols: number) =>
	fc
		.record({
			x: fc.integer({ min: -2, max: cols + 2 }),
			y: fc.integer({ min: 0, max: 40 }),
			w: fc.integer({ min: 1, max: cols + 2 }),
			h: fc.integer({ min: 1, max: 10 }),
			minW: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
			minH: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
			maxW: fc.option(fc.integer({ min: 4, max: Math.max(4, cols) }), { nil: undefined }),
			maxH: fc.option(fc.integer({ min: 4, max: 12 }), { nil: undefined }),
		})
		.map(({ minW, minH, maxW, maxH, ...box }) => {
			// Absent, not `undefined`: stored layouts omit the keys.
			const item: {
				x: number
				y: number
				w: number
				h: number
				minW?: number
				minH?: number
				maxW?: number
				maxH?: number
			} = box
			if (minW !== undefined) item.minW = minW
			if (minH !== undefined) item.minH = minH
			if (maxW !== undefined) item.maxW = maxW
			if (maxH !== undefined) item.maxH = maxH
			return item
		})

export const layoutArb = (cols: number, maxLength = 40): fc.Arbitrary<Layout> =>
	fc
		.array(itemArb(cols), { minLength: 0, maxLength })
		.map((items) => items.map((item, index): GridItem => ({ i: `w${index}`, ...item })))

/** A layout that is already in bounds, like anything the grid has drawn once. */
export const cleanLayoutArb = (cols: number, maxLength = 40): fc.Arbitrary<Layout> =>
	fc
		.array(
			fc
				.record({
					w: fc.integer({ min: 1, max: cols }),
					h: fc.integer({ min: 1, max: 8 }),
					x: fc.nat(),
					y: fc.integer({ min: 0, max: 40 }),
				})
				.map((box) => ({ ...box, x: box.x % (cols - box.w + 1) })),
			{ minLength: 1, maxLength },
		)
		.map((items) => items.map((item, index): GridItem => ({ i: `w${index}`, ...item })))

export type Op =
	| { readonly kind: "move"; readonly pick: number; readonly x: number; readonly y: number }
	| { readonly kind: "resize"; readonly pick: number; readonly w: number; readonly h: number }

export const opArb = (cols: number): fc.Arbitrary<Op> =>
	fc.oneof(
		fc.record({
			kind: fc.constant("move" as const),
			pick: fc.nat(),
			x: fc.integer({ min: -1, max: cols }),
			y: fc.integer({ min: -1, max: 50 }),
		}),
		fc.record({
			kind: fc.constant("resize" as const),
			pick: fc.nat(),
			w: fc.integer({ min: 0, max: cols + 1 }),
			h: fc.integer({ min: 0, max: 12 }),
		}),
	)

/** Only the boxes, in order, for comparing implementations. */
export function boxes(layout: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>) {
	return layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
}
