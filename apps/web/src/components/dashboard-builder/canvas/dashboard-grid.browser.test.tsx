/**
 * The dashboard grid in a real browser: where tiles are drawn, and what drag,
 * resize and keyboard rearranging report back.
 *
 * Geometry is asserted on rendered boxes, never class names or inline styles,
 * because the browser does the placement (CSS Grid) and a regression would show
 * up nowhere else. Interactions are driven with real `PointerEvent`s and key
 * presses through the same listeners a user hits.
 */
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cellAt, changedItems, itemRect, moveItem, normalizeLayout, type Layout } from "@maple/grid-engine"

import { DashboardGrid, type LayoutCommit } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import {
	GRID_ROW_HEIGHT,
	GRID_TIERS,
	type GridTier,
} from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { useGridHandleDescription } from "@/components/dashboard-builder/canvas/grid-handle-context"

afterEach(cleanup)

interface TestWidget {
	id: string
	layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number }
}

const widget = (id: string, x: number, y: number, w: number, h: number): TestWidget => ({
	id,
	layout: { x, y, w, h, minW: 1, minH: 1 },
})

/**
 * Counts renders per widget, so a test can prove moving a tile never re-renders
 * what is in it. Deliberately not `memo`: the grid has to guarantee that itself,
 * not lean on every renderer remembering to memoise.
 */
const renders = new Map<string, number>()

function TestTile({ widget }: { widget: TestWidget }) {
	renders.set(widget.id, (renders.get(widget.id) ?? 0) + 1)
	const describedBy = useGridHandleDescription()
	return (
		<div style={{ height: "100%" }}>
			<button
				type="button"
				className="widget-drag-handle"
				data-grid-label={widget.id}
				aria-label={`Move ${widget.id}`}
				aria-describedby={describedBy}
			>
				grip
			</button>
		</div>
	)
}

const BOARD = [widget("a", 0, 0, 6, 4), widget("b", 6, 0, 6, 4), widget("c", 0, 4, 12, 4)]
const WIDTH = 1200
const [CANONICAL] = GRID_TIERS

function mount(options: {
	widgets?: TestWidget[]
	editable?: boolean
	tier?: GridTier
	width?: number
	onLayoutCommit?: (layouts: LayoutCommit) => void
}) {
	const {
		widgets = BOARD,
		editable = true,
		tier = CANONICAL,
		width = WIDTH,
		onLayoutCommit = vi.fn(),
	} = options
	renders.clear()
	const view = render(
		<div style={{ width }}>
			<DashboardGrid
				widgets={widgets}
				width={width}
				tier={tier}
				editable={editable}
				renderWidget={TestTile}
				onLayoutCommit={onLayoutCommit}
			/>
		</div>,
	)
	const grid = view.container.querySelector<HTMLElement>("[data-dashboard-grid]")!
	const cell = (id: string) => grid.querySelector<HTMLElement>(`[data-grid-item="${id}"]`)!
	const handle = (id: string) => cell(id).querySelector<HTMLElement>(".widget-drag-handle")!
	const resizer = (id: string) => cell(id).querySelector<HTMLElement>("[data-grid-resize-handle]")
	const box = (id: string) => cell(id).dataset.gridBox
	return { ...view, grid, cell, handle, resizer, box, onLayoutCommit }
}

const geometryFor = (tier: GridTier, width: number) => ({
	width,
	cols: tier.cols,
	rowHeight: GRID_ROW_HEIGHT,
	gap: tier.margin,
	padding: [0, tier.margin[1]] as const,
})

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function pointer(type: string, target: EventTarget, x: number, y: number) {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
			pointerId: 1,
			button: 0,
			isPrimary: true,
		}),
	)
}

/** Press on `from`, move by (dx, dy) in `steps` frames, then release (or not). */
async function dragBy(from: HTMLElement, dx: number, dy: number, { steps = 8, release = true } = {}) {
	const start = from.getBoundingClientRect()
	const x = start.left + start.width / 2
	const y = start.top + start.height / 2
	await act(async () => {
		pointer("pointerdown", from, x, y)
	})
	for (let step = 1; step <= steps; step++) {
		await act(async () => {
			pointer("pointermove", document.body, x + (dx * step) / steps, y + (dy * step) / steps)
			await nextFrame()
		})
	}
	if (release) {
		await act(async () => {
			pointer("pointerup", document.body, x + dx, y + dy)
			await nextFrame()
		})
	}
}

async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
	})
}

describe("placement", () => {
	it.each(GRID_TIERS.map((tier) => [tier.cols, tier] as const))(
		"draws every tile where the grid geometry says, at %i columns",
		(_cols, tier) => {
			const width = Math.max(tier.minWidth + 40, 360)
			const widgets = [widget("a", 0, 0, 3, 2), widget("b", 3, 0, 9, 5), widget("c", 0, 5, 12, 3)]
			const { grid, cell } = mount({ widgets, tier, width, editable: false })
			const gridBox = grid.getBoundingClientRect()
			const geometry = geometryFor(tier, width)

			for (const { id } of widgets) {
				const drawn = cell(id).getBoundingClientRect()
				const [x, y, w, h] = cell(id).dataset.gridBox!.split(",").map(Number)
				const expected = itemRect(geometry, { x: x!, y: y!, w: w!, h: h! })
				expect(Math.abs(drawn.left - gridBox.left - expected.left), `${id} left`).toBeLessThanOrEqual(
					1,
				)
				expect(Math.abs(drawn.top - gridBox.top - expected.top), `${id} top`).toBeLessThanOrEqual(1)
				expect(Math.abs(drawn.width - expected.width), `${id} width`).toBeLessThanOrEqual(1)
				expect(Math.abs(drawn.height - expected.height), `${id} height`).toBeLessThanOrEqual(1)
			}
		},
	)

	it("sizes the grid to its lowest tile plus the vertical gap above and below", () => {
		const { grid } = mount({ editable: false })
		// 8 rows of 60px with 7 gaps between them, plus padding top and bottom.
		const rows = 8
		const expected = rows * GRID_ROW_HEIGHT + (rows - 1) * CANONICAL.margin[1] + 2 * CANONICAL.margin[1]
		expect(grid.getBoundingClientRect().height).toBeCloseTo(expected, 0)
	})

	// Stored boards can overlap or float (MCP writes, imports, older clients).
	// The grid draws them packed, exactly as react-grid-layout did, so nothing
	// moves on deploy.
	it("draws an overlapping, floating stored board packed", () => {
		const widgets = [widget("a", 0, 3, 6, 4), widget("b", 2, 3, 6, 4), widget("c", 10, 20, 4, 2)]
		const { box } = mount({ widgets, editable: false })
		const expected = normalizeLayout(
			widgets.map((w) => ({ i: w.id, ...w.layout })),
			12,
			"vertical",
		)
		for (const item of expected) expect(box(item.i)).toBe(`${item.x},${item.y},${item.w},${item.h}`)
		expect(box("c")).toBe("8,0,4,2")
	})
})

describe("read-only", () => {
	it("renders no resize handles and ignores a drag on the grip", async () => {
		const { handle, resizer, box, onLayoutCommit } = mount({ editable: false })
		expect(resizer("a")).toBeNull()
		await dragBy(handle("a"), 606, 0)
		expect(box("a")).toBe("0,0,6,4")
		expect(onLayoutCommit).not.toHaveBeenCalled()
	})

	it("reports nothing when the tier or width changes under it", () => {
		const onLayoutCommit = vi.fn()
		const view = mount({ onLayoutCommit })
		view.rerender(
			<div style={{ width: 700 }}>
				<DashboardGrid
					widgets={BOARD}
					width={700}
					tier={GRID_TIERS[1]!}
					editable={false}
					renderWidget={TestTile}
					onLayoutCommit={onLayoutCommit}
				/>
			</div>,
		)
		expect(onLayoutCommit).not.toHaveBeenCalled()
	})
})

describe("pointer drag", () => {
	const stored: Layout = BOARD.map((w) => ({ i: w.id, ...w.layout }))
	const geometry = geometryFor(CANONICAL, WIDTH)
	const column = (WIDTH - 11 * CANONICAL.margin[0]) / 12 + CANONICAL.margin[0]

	it("moves a tile and commits exactly once, with only the tiles that changed", async () => {
		const { handle, box, onLayoutCommit } = mount({})
		await dragBy(handle("a"), column * 6, 0)

		const aStart = itemRect(geometry, stored[0]!)
		const target = cellAt(geometry, stored[0]!, aStart.left + column * 6, aStart.top)
		const expected = moveItem(stored, "a", target.x, target.y)
		expect(onLayoutCommit).toHaveBeenCalledTimes(1)
		expect(onLayoutCommit).toHaveBeenCalledWith(
			changedItems(stored, expected).map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
		)
		for (const item of expected) expect(box(item.i)).toBe(`${item.x},${item.y},${item.w},${item.h}`)
	})

	it("treats a press that travels less than the threshold as a click", async () => {
		const { handle, cell, grid, onLayoutCommit } = mount({})
		await dragBy(handle("a"), 2, 0, { steps: 1, release: false })
		expect(grid.querySelector("[data-grid-placeholder]")).toBeNull()
		expect(getComputedStyle(cell("a")).position).toBe("relative")
		await dragBy(handle("a"), 0, 4, { steps: 1, release: false })
		expect(grid.querySelector("[data-grid-placeholder]")).not.toBeNull()
		await act(async () => {
			pointer("pointerup", document.body, 0, 0)
			await nextFrame()
		})
		expect(onLayoutCommit).not.toHaveBeenCalled()
	})

	it("shows a placeholder while dragging and lifts the tile out of the flow", async () => {
		const { handle, cell, grid } = mount({})
		await dragBy(handle("a"), column * 6, 0, { release: false })
		expect(grid.querySelector("[data-grid-placeholder]")).not.toBeNull()
		expect(getComputedStyle(cell("a")).position).toBe("absolute")
		expect(cell("a").style.transform).toContain("translate3d")
		await act(async () => {
			pointer("pointerup", document.body, 0, 0)
			await nextFrame()
		})
		expect(grid.querySelector("[data-grid-placeholder]")).toBeNull()
		expect(cell("a").style.transform).toBe("")
	})

	// A glide animates `transform`, which is also what keeps the carried tile
	// under the pointer; one on the carried tile yanks it back toward its slot
	// at every cell boundary, which reads as flicker.
	it("never animates the carried tile, only the tiles it displaces", async () => {
		const { handle, cell } = mount({})
		await dragBy(handle("a"), column * 6, 0, { release: false })
		expect(cell("a").getAnimations()).toHaveLength(0)
		expect(cell("b").getAnimations().length).toBeGreaterThan(0)
		await act(async () => {
			pointer("pointerup", document.body, 0, 0)
			await nextFrame()
		})
	})

	it("puts everything back and commits nothing on Escape", async () => {
		const { handle, box, onLayoutCommit } = mount({})
		await dragBy(handle("a"), column * 6, 0, { release: false })
		expect(box("a")).not.toBe("0,0,6,4")
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
			await nextFrame()
		})
		expect(box("a")).toBe("0,0,6,4")
		expect(box("b")).toBe("6,0,6,4")
		expect(onLayoutCommit).not.toHaveBeenCalled()
	})

	it("commits nothing when the tile is carried away and brought back", async () => {
		const { handle, box, onLayoutCommit } = mount({})
		const start = handle("a").getBoundingClientRect()
		const x = start.left + start.width / 2
		const y = start.top + start.height / 2
		await act(async () => pointer("pointerdown", handle("a"), x, y))
		for (const dx of [column, column * 3, column * 6, column * 3, 0]) {
			await act(async () => {
				pointer("pointermove", document.body, x + dx, y)
				await nextFrame()
			})
		}
		await act(async () => {
			pointer("pointerup", document.body, x, y)
			await nextFrame()
		})
		expect(box("a")).toBe("0,0,6,4")
		expect(onLayoutCommit).not.toHaveBeenCalled()
	})

	it("never re-renders a tile's content while dragging across the board", async () => {
		const { handle } = mount({})
		const before = new Map(renders)
		await dragBy(handle("c"), column * 2, -GRID_ROW_HEIGHT * 5, { steps: 20 })
		expect(renders).toEqual(before)
	})
})

describe("pointer resize", () => {
	const row = GRID_ROW_HEIGHT + CANONICAL.margin[1]

	it("snaps to whole cells, pushes neighbours down, and commits once", async () => {
		const { resizer, box, onLayoutCommit } = mount({})
		const handle = resizer("a")!
		await dragBy(handle, 0, row * 2)
		expect(box("a")).toBe("0,0,6,6")
		expect(box("c")).toBe("0,6,12,4")
		expect(onLayoutCommit).toHaveBeenCalledTimes(1)
		expect(onLayoutCommit).toHaveBeenCalledWith([
			{ i: "a", x: 0, y: 0, w: 6, h: 6 },
			{ i: "c", x: 0, y: 6, w: 12, h: 4 },
		])
	})

	it("stops at the grid's right edge", async () => {
		const { resizer, box } = mount({})
		await dragBy(resizer("b")!, 2000, 0)
		expect(box("b")).toBe("6,0,6,4")
	})
})

describe("keyboard", () => {
	it("picks up, moves, drops and commits, announcing each step", async () => {
		const { handle, box, grid, onLayoutCommit } = mount({})
		const grip = handle("a")
		grip.focus()
		await press(grip, " ")
		expect(grid.querySelector("output")?.textContent).toContain("Picked up a")
		await press(grip, "ArrowRight")
		expect(box("a")).not.toBe("0,0,6,4")
		expect(grid.querySelector("output")?.textContent).toMatch(/^a: column/)
		await press(grip, " ")
		expect(onLayoutCommit).toHaveBeenCalledTimes(1)
		expect(grid.querySelector("output")?.textContent).toContain("a dropped at")
		expect(document.activeElement).toBe(grip)
	})

	it("resizes with Shift and the arrow keys", async () => {
		const { handle, box } = mount({})
		const grip = handle("a")
		grip.focus()
		await press(grip, "Enter")
		await press(grip, "ArrowDown", { shiftKey: true })
		expect(box("a")).toBe("0,0,6,5")
		await press(grip, "ArrowLeft", { shiftKey: true })
		expect(box("a")).toBe("0,0,5,5")
	})

	it("cancels with Escape", async () => {
		const { handle, box, onLayoutCommit, grid } = mount({})
		const grip = handle("a")
		grip.focus()
		await press(grip, " ")
		await press(grip, "ArrowDown")
		await press(grip, "Escape")
		expect(box("a")).toBe("0,0,6,4")
		expect(onLayoutCommit).not.toHaveBeenCalled()
		expect(grid.querySelector("output")?.textContent).toContain("Move cancelled")
	})

	it("drops where it is when focus leaves the tile", async () => {
		const { handle, onLayoutCommit } = mount({})
		const grip = handle("a")
		grip.focus()
		await press(grip, " ")
		await press(grip, "ArrowRight")
		await act(async () => {
			handle("b").focus()
		})
		expect(onLayoutCommit).toHaveBeenCalledTimes(1)
	})

	it("describes the keyboard controls on every grip, and only when editable", () => {
		const { handle, grid, unmount } = mount({})
		const instructions = grid.querySelector<HTMLElement>("p[hidden]")
		expect(instructions?.textContent).toContain("Press Space to pick up")
		expect(handle("a").getAttribute("aria-describedby")).toBe(instructions?.id)
		unmount()
		const readOnly = mount({ editable: false })
		expect(readOnly.handle("a").hasAttribute("aria-describedby")).toBe(false)
	})

	it("ignores keys in view mode", async () => {
		const { handle, box } = mount({ editable: false })
		const grip = handle("a")
		grip.focus()
		await press(grip, " ")
		await press(grip, "ArrowRight")
		expect(box("a")).toBe("0,0,6,4")
	})
})
