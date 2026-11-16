import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import {
	clampViewport,
	flameNodeAt,
	FULL_VIEWPORT,
	isZoomed,
	layoutFlame,
	MIN_VIEWPORT_SPAN,
	neighbour,
	panViewport,
	rulerStep,
	startFrame,
	toAxis,
	toPixel,
	viewForNewRoot,
	viewportOf,
	zoomAnchor,
	zoomViewport,
} from "./flame-geometry"
import { type ProfileInput, profileTree } from "./profile-tree"

const stack = (frames: ReadonlyArray<string>, value: number) => ({
	frames,
	files: Arr.map(frames, () => "/app/server.js"),
	lines: Arr.map(frames, () => 1),
	value,
})

// main 100: handle 90 (parse 60, render 30), gc 10
const input: ProfileInput = {
	stacks: [
		stack(["main", "handle", "parse"], 60),
		stack(["main", "handle", "render"], 30),
		stack(["main", "gc"], 10),
	],
	totalValue: 100,
}
const layout = layoutFlame(profileTree(input))
const named = (name: string) =>
	Option.getOrUndefined(Arr.findFirst([...layout.byId.values()], (frame) => frame.node.name === name))
const extent = (name: string) => [named(name)?.x0, named(name)?.x1]

describe("layoutFlame", () => {
	it("gives each frame its share of the axis, after its heavier siblings", () => {
		expect(extent("handle")).toEqual([0, 0.9])
		expect(extent("parse")).toEqual([0, 0.6])
		expect(extent("render")[0]).toBeCloseTo(0.6)
		expect(extent("render")[1]).toBeCloseTo(0.9)
		expect(extent("gc")[0]).toBeCloseTo(0.9)
		expect(layout.rows).toBe(4)
	})
})

describe("flameNodeAt", () => {
	it.each([
		[0.3, 3, "parse"],
		[0.7, 3, "render"],
		[0.7, 2, "handle"],
		[0.95, 2, "gc"],
		[0.5, 0, "all"],
	])("finds the frame at x=%d on row %d: %s", (x, depth, name) => {
		expect(flameNodeAt(layout, x, depth)?.node.name).toBe(name)
	})

	it("finds nothing below a frame that called nothing there", () => {
		expect(flameNodeAt(layout, 0.95, 3)).toBeUndefined()
		expect(flameNodeAt(layout, 1.2, 1)).toBeUndefined()
	})
})

describe("zoomViewport", () => {
	it("keeps the point under the cursor where it was on screen", () => {
		const before = { start: 0.2, end: 0.6 }
		const anchor = 0.3
		const after = zoomViewport(before, anchor, 0.5)
		expect(after.end - after.start).toBeCloseTo(0.2)
		expect(toPixel(after, anchor, 800)).toBeCloseTo(toPixel(before, anchor, 800))
	})

	it("stops at the whole profile on the way out and at the floor on the way in", () => {
		expect(zoomViewport({ start: 0.4, end: 0.6 }, 0.5, 100)).toEqual(FULL_VIEWPORT)
		const deep = zoomViewport(FULL_VIEWPORT, 0.5, 1e-12)
		expect(deep.end - deep.start).toBeCloseTo(MIN_VIEWPORT_SPAN)
	})
})

describe("panViewport", () => {
	it("slides the window and stops at either end without changing its width", () => {
		expect(panViewport({ start: 0.2, end: 0.4 }, 0.1)).toEqual({
			start: expect.closeTo(0.3),
			end: expect.closeTo(0.5),
		})
		expect(panViewport({ start: 0.2, end: 0.4 }, -5)).toEqual({ start: 0, end: expect.closeTo(0.2) })
		expect(panViewport({ start: 0.2, end: 0.4 }, 5)).toEqual({ start: expect.closeTo(0.8), end: 1 })
	})
})

describe("viewportOf", () => {
	it("fits a frame edge to edge", () => {
		const render = named("render")
		const fitted = viewportOf(render ?? { x0: 0, x1: 1 })
		expect([toPixel(fitted, render?.x0 ?? 0, 500), toPixel(fitted, render?.x1 ?? 0, 500)]).toEqual([
			expect.closeTo(0),
			expect.closeTo(500),
		])
		expect(isZoomed(fitted)).toBe(true)
		expect(isZoomed(FULL_VIEWPORT)).toBe(false)
	})
})

describe("pixel and axis conversion", () => {
	it("round-trips through a zoomed window", () => {
		const viewport = { start: 0.25, end: 0.75 }
		expect(toAxis(viewport, toPixel(viewport, 0.4, 640), 640)).toBeCloseTo(0.4)
		expect(clampViewport({ start: -1, end: 3 })).toEqual(FULL_VIEWPORT)
	})
})

describe("rulerStep", () => {
	it.each([
		[1000, 5, 200],
		[32_000, 8, 5000],
		[7, 5, 2],
		[0.9, 4, 0.5],
	])("over %d units at about %d ticks steps by %d", (span, target, step) => {
		expect(rulerStep(span, target)).toBeCloseTo(step)
	})
})

describe("neighbour", () => {
	it("moves to the caller, the heaviest callee and the siblings", () => {
		const handle = named("handle")
		expect([
			handle && neighbour(handle, "up")?.node.name,
			handle && neighbour(handle, "down")?.node.name,
			handle && neighbour(handle, "right")?.node.name,
			handle && neighbour(handle, "left")?.node.name,
		]).toEqual(["main", "parse", "gc", undefined])
	})
})

describe("startFrame", () => {
	it("starts on the heaviest frame under the root", () => {
		expect(startFrame(layout).node.name).toBe("main")
		const flat = layoutFlame(
			profileTree({
				stacks: [stack(["idle"], 5), stack(["work"], 40), stack(["gc"], 15)],
				totalValue: 60,
			}),
		)
		expect(startFrame(flat).node.name).toBe("work")
	})

	it("starts on the root of a profile with no frames", () => {
		const empty = layoutFlame(profileTree({ stacks: [], totalValue: 0 }))
		expect(startFrame(empty)).toBe(empty.root)
	})
})

describe("zoomAnchor", () => {
	const viewport = { start: 0.2, end: 0.6 }

	it("is the axis position under the pointer, wherever a wide frame's centre is", () => {
		expect(zoomAnchor(viewport, 200, 800)).toBeCloseTo(0.3)
		expect(zoomAnchor(viewport, 0, 800)).toBeCloseTo(0.2)
	})

	it("is the middle of the window with no pointer over the chart", () => {
		expect(zoomAnchor(viewport, undefined, 800)).toBeCloseTo(0.4)
	})

	it("keeps what is under the pointer in place through a keyboard zoom", () => {
		const anchor = zoomAnchor(viewport, 600, 800)
		expect(toPixel(zoomViewport(viewport, anchor, 0.6), anchor, 800)).toBeCloseTo(600)
	})
})

describe("viewForNewRoot", () => {
	const zoomed = { viewport: { start: 0.25, end: 0.5 }, scrollY: 90 }

	it("keeps the zoom and the scroll when the same view gets a new tree", () => {
		expect(viewForNewRoot(zoomed, true, 400)).toEqual(zoomed)
	})

	it("brings the scroll back inside a shallower tree", () => {
		expect(viewForNewRoot(zoomed, true, 36)).toEqual({ viewport: zoomed.viewport, scrollY: 36 })
		expect(viewForNewRoot(zoomed, true, 0).scrollY).toBe(0)
	})

	it("returns to the whole profile from the top when the view changed", () => {
		expect(viewForNewRoot(zoomed, false, 400)).toEqual({ viewport: FULL_VIEWPORT, scrollY: 0 })
	})
})
