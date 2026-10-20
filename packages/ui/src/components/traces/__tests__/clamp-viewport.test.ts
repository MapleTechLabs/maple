import { describe, expect, it } from "vitest"
import { clampViewport, viewportBounds } from "../clamp-viewport"
import { MIN_VISIBLE_ABS_MS } from "../trace-timeline-types"

const TRACE_START = 0
const TRACE_END = 10_000 // 10s trace

describe("clampViewport min-visible floor", () => {
	it("floors a zero-width window to the absolute minimum", () => {
		const vp = clampViewport({ startMs: 5_000, endMs: 5_000 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
		expect(vp.startMs).toBeCloseTo(5_000, 6)
	})

	it("never collapses below the absolute floor on a tiny trace", () => {
		const vp = clampViewport({ startMs: 50, endMs: 50 }, 0, 100)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
	})

	it("caps an over-wide window at the trace plus its trailing slack", () => {
		const vp = clampViewport({ startMs: -50_000, endMs: 50_000 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(10_500, 6)
	})

	it("keeps a normal window untouched", () => {
		const vp = clampViewport({ startMs: 2_000, endMs: 4_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeCloseTo(2_000, 6)
		expect(vp.endMs).toBeCloseTo(4_000, 6)
	})
})

describe("clampViewport boundaries", () => {
	const LO = TRACE_START // flush: zero is the left edge of the column
	const HI = TRACE_END + 10_000 * 0.05 // 10_500 (trailing slack only)

	it("clamps a window fully left of the trace back inside", () => {
		const vp = clampViewport({ startMs: -30_000, endMs: -28_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeGreaterThanOrEqual(LO)
		expect(vp.endMs).toBeLessThanOrEqual(HI)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
	})

	it("clamps a window fully right of the trace back inside", () => {
		const vp = clampViewport({ startMs: 40_000, endMs: 42_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeGreaterThanOrEqual(LO)
		expect(vp.endMs).toBeLessThanOrEqual(HI)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
	})

	it("centers a window capped to the max width (no left-edge re-violation)", () => {
		const vp = clampViewport({ startMs: -1_000, endMs: 11_500 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(10_500, 6)
		expect(vp.startMs).toBeCloseTo(LO, 6)
		expect(vp.endMs).toBeCloseTo(HI, 6)
	})

	it("stays finite and floored on a zero-duration trace", () => {
		const vp = clampViewport({ startMs: 5_000, endMs: 5_000 }, 5_000, 5_000)
		expect(Number.isFinite(vp.startMs)).toBe(true)
		expect(Number.isFinite(vp.endMs)).toBe(true)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
		// Centered on the instant
		expect((vp.startMs + vp.endMs) / 2).toBeCloseTo(5_000, 6)
	})

	it("recovers from NaN/Infinity inputs", () => {
		for (const bad of [
			{ startMs: Number.NaN, endMs: Number.NaN },
			{ startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY },
			{ startMs: 0, endMs: Number.POSITIVE_INFINITY },
		]) {
			const vp = clampViewport(bad, TRACE_START, TRACE_END)
			expect(Number.isFinite(vp.startMs)).toBe(true)
			expect(Number.isFinite(vp.endMs)).toBe(true)
			expect(vp.endMs).toBeGreaterThan(vp.startMs)
		}
	})
})

describe("viewportBounds is the shared coordinate space", () => {
	// The minimap strip, the ruler and the span bars all have to agree on where a given instant
	// sits. They do that by sharing one domain: the padded bounds. When the minimap drew the bare
	// trace instead, trace-zero landed at 0% of the strip but 4.5% into the column — an ~80px
	// disagreement at full zoom-out.
	it("starts flush at the trace and pads only the tail", () => {
		// Flush left is the point: a leading pad puts an empty strip in front of the first span,
		// so the waterfall looks offset from its own ruler. The tail slack is label room.
		const b = viewportBounds(TRACE_START, TRACE_END)
		expect(b.loMs).toBe(TRACE_START)
		expect(b.hiMs).toBeCloseTo(10_500, 6)
		expect(b.durationMs).toBeCloseTo(10_500, 6)
	})

	it("puts trace-zero at the very left of the domain", () => {
		// The property the leading gap violated: the first instant of the trace maps to 0%.
		const b = viewportBounds(TRACE_START, TRACE_END)
		expect((TRACE_START - b.loMs) / b.durationMs).toBe(0)
	})

	it("is exactly the widest window clampViewport will hand back", () => {
		// If these ever diverge, a "fitted" timeline can't line up with the strip.
		const b = viewportBounds(TRACE_START, TRACE_END)
		const widest = clampViewport({ startMs: -1e9, endMs: 1e9 }, TRACE_START, TRACE_END)
		expect(widest.startMs).toBeCloseTo(b.loMs, 6)
		expect(widest.endMs).toBeCloseTo(b.hiMs, 6)
	})

	it("stays finite on a zero-duration trace", () => {
		const b = viewportBounds(5_000, 5_000)
		expect(b.loMs).toBe(5_000)
		expect(b.hiMs).toBe(5_000)
		expect(b.durationMs).toBe(0)
	})
})
