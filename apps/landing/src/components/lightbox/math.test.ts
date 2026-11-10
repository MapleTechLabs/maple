import { describe, expect, it } from "vitest"
import * as M from "./math"

// A 1000 x 500 shot resting in the middle of a 1200 x 800 viewer whose bitmap is 3x its box.
const frame: M.Frame = {
	media: { width: 1000, height: 500 },
	center: { x: 600, y: 400 },
	viewport: { width: 1200, height: 800 },
	maxScale: 3,
}

/** Where a point of the shot (measured from its centre, at rest) is drawn under a pose. */
const drawnAt = (pose: M.Pose, point: M.Point): M.Point => ({
	x: frame.center.x + pose.x + pose.scale * point.x,
	y: frame.center.y + pose.y + pose.scale * point.y,
})

describe("zoom bounds", () => {
	it("stops where the bitmap's own pixels are on screen", () => {
		expect(M.maxScaleOf({ width: 3000, height: 1500 }, { width: 1000, height: 500 })).toBe(3)
	})

	it("always allows one doubling, and never a bitmap blown past recognition", () => {
		const shown = { width: 1000, height: 500 }
		expect(M.maxScaleOf({ width: 1000, height: 500 }, shown)).toBe(M.stepScale(frame, 1, "in"))
		// However large the bitmap: past a point there is nothing more to read.
		const huge = M.maxScaleOf({ width: 20_000, height: 10_000 }, shown)
		expect(huge).toBeLessThan(20_000 / shown.width)
		expect(M.maxScaleOf({ width: 200_000, height: 100_000 }, shown)).toBe(huge)
		expect(M.maxScaleOf({ width: 0, height: 0 }, { width: 0, height: 0 })).toBeGreaterThan(1)
	})

	it("steps by doubling and halving inside the bounds", () => {
		expect(M.stepScale(frame, 1, "in")).toBe(2)
		expect(M.stepScale(frame, 2, "in")).toBe(3)
		expect(M.stepScale(frame, 3, "out")).toBe(1.5)
		expect(M.stepScale(frame, 1.5, "out")).toBe(1)
	})

	it("toggles between rest and one step in on a double tap", () => {
		expect(M.toggledScale(frame, 1)).toBe(2)
		expect(M.toggledScale(frame, 2.4)).toBe(1)
		expect(M.toggledScale({ ...frame, maxScale: 1.5 }, 1)).toBe(1.5)
	})

	it("reads a wheel tick as a zoom factor, capped at one doubling either way", () => {
		expect(M.wheelScale(1, -100)).toBe(2)
		expect(M.wheelScale(2, 100)).toBe(1)
		expect(M.wheelScale(1, -5000)).toBe(2)
		expect(M.wheelScale(1.5, 0)).toBe(1.5)
	})
})

describe("zooming about a point", () => {
	it("keeps the point of the shot under the pointer where it is", () => {
		const focal = { x: 900, y: 300 }
		const before = { scale: 1.4, x: -60, y: 35 }
		// The point of the shot currently under the pointer.
		const point = {
			x: (focal.x - frame.center.x - before.x) / before.scale,
			y: (focal.y - frame.center.y - before.y) / before.scale,
		}
		const after = M.zoomAbout(frame, before, 2.6, focal)
		expect(after.scale).toBe(2.6)
		expect(drawnAt(after, point).x).toBeCloseTo(focal.x)
		expect(drawnAt(after, point).y).toBeCloseTo(focal.y)
	})

	it("does not zoom past the bounds", () => {
		expect(M.zoomAbout(frame, M.REST, 40, { x: 600, y: 400 }).scale).toBe(frame.maxScale)
		expect(M.zoomAbout(frame, { scale: 2, x: 0, y: 0 }, 0.1, { x: 600, y: 400 }).scale).toBe(1)
	})
})

describe("pan bounds", () => {
	it("returns to rest once the shot is no longer zoomed", () => {
		expect(M.clampPose(frame, { scale: 1, x: 240, y: -90 })).toEqual(M.REST)
		expect(M.clampPose(frame, { scale: 0.7, x: 10, y: 10 })).toEqual(M.REST)
	})

	it("lets an overflowing shot pan until its edge meets the viewer's, and no further", () => {
		// At 2x the shot is 2000 x 1000: 400 of overhang each side, 100 above and below.
		const pose = M.clampPose(frame, { scale: 2, x: 9999, y: -9999 })
		expect(pose).toEqual({ scale: 2, x: 400, y: -100 })
		expect(drawnAt(pose, { x: -500, y: 250 })).toEqual({ x: 0, y: 800 })
	})

	it("keeps an axis that still fits the viewer where it is", () => {
		// At 1.3x the shot is 1300 x 650: wider than the viewer, not taller.
		const pose = M.clampPose(frame, { scale: 1.3, x: 0, y: 300 })
		expect(pose.y).toBe(0)
		expect(M.panRange(frame, 1.3).x).toEqual([-50, 50])
	})

	it("pulls a zoomed shot that rests off-centre toward the middle of the viewer", () => {
		const offCentre = { ...frame, center: { x: 600, y: 300 } }
		const [min, max] = M.panRange(offCentre, 2).y
		expect((min + max) / 2).toBe(100)
	})

	it("follows a drag freely inside the bounds and less and less beyond them", () => {
		const reach = M.RUBBER_BAND_REACH.touch
		expect(M.bandPose(frame, { scale: 2, x: 150, y: 0 }, reach).x).toBe(150)
		const near = M.bandPose(frame, { scale: 2, x: 500, y: 0 }, reach).x - 400
		const far = M.bandPose(frame, { scale: 2, x: 2400, y: 0 }, reach).x - 400
		expect(near).toBeGreaterThan(0)
		expect(near).toBeLessThan(100)
		expect(far).toBeGreaterThan(near)
		expect(far).toBeLessThan(frame.viewport.width * reach)
	})

	it("lets a released pan coast in its direction without leaving the bounds", () => {
		const from = { scale: 2, x: 0, y: 0 }
		expect(M.coastTarget(frame, from, { x: 320, y: 0 }).x).toBe(100)
		expect(M.coastTarget(frame, from, { x: 90_000, y: 0 }).x).toBe(400)
	})
})

describe("pull to dismiss", () => {
	it("trails the finger, shrinking as it nears the dismiss distance", () => {
		const short = M.pullOf(0, 40)
		const long = M.pullOf(0, M.PULL_DISMISS_DISTANCE)
		expect(short.y).toBeGreaterThan(0)
		expect(short.y).toBeLessThan(40)
		expect(long.y).toBeGreaterThan(short.y)
		expect(long.scale).toBeLessThan(short.scale)
		expect(long.progress).toBe(1)
		expect(M.pullOf(0, 900).progress).toBe(1)
		expect(M.pullOf(0, -40).y).toBe(-short.y)
	})

	it("holds the shot nearly on its column while it is pulled", () => {
		const pull = M.pullOf(300, 120)
		expect(pull.x).toBeGreaterThan(0)
		expect(pull.x).toBeLessThan(60)
	})

	it("starts at rest", () => {
		expect(M.pullOf(0, 0)).toEqual({ x: 0, y: 0, scale: 1, progress: 0 })
	})

	it("dismisses on distance, or on a flick the way it was dragged", () => {
		expect(M.isDismissal(M.PULL_DISMISS_DISTANCE, 0)).toBe(true)
		expect(M.isDismissal(-160, 0)).toBe(true)
		expect(M.isDismissal(30, 900)).toBe(true)
		expect(M.isDismissal(30, 120)).toBe(false)
		// Flicked back toward where it came from: the visitor changed their mind.
		expect(M.isDismissal(60, -900)).toBe(false)
	})

	it("snaps back along a curve that starts where the shot was let go and ends at rest", () => {
		const stops = (easing: string) => easing.slice("linear(".length, -1).split(", ").map(Number)
		const still = stops(M.snapEasing(0, 60))
		expect(still[0]).toBe(0)
		expect(still[still.length - 1]).toBeGreaterThan(0.98)
		expect(still.every((stop, index) => index === 0 || stop >= (still[index - 1] ?? 0))).toBe(true)
		// Thrown toward rest, it gets there sooner.
		const thrown = stops(M.snapEasing(-900, 60))
		expect(thrown[5] ?? 0).toBeGreaterThan(still[5] ?? 0)
	})
})

describe("pointer samples", () => {
	it("measures velocity across the samples, in pixels per second", () => {
		expect(
			M.velocityOf([
				{ x: 0, y: 0, at: 1000 },
				{ x: 10, y: -4, at: 1010 },
				{ x: 30, y: -20, at: 1050 },
			]),
		).toEqual({ x: 600, y: -400 })
	})

	it("is still without two moments to compare", () => {
		expect(M.velocityOf([])).toEqual({ x: 0, y: 0 })
		expect(M.velocityOf([{ x: 5, y: 5, at: 10 }])).toEqual({ x: 0, y: 0 })
	})
})

describe("slides", () => {
	it("picks the slide whose snap position is nearest", () => {
		const offsets = [0, 400, 800, 1200]
		expect(M.slideAt(offsets, 0)).toBe(0)
		expect(M.slideAt(offsets, 190)).toBe(0)
		expect(M.slideAt(offsets, 230)).toBe(1)
		expect(M.slideAt(offsets, 5000)).toBe(3)
		expect(M.slideAt([], 100)).toBe(0)
	})
})
