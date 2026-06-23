import { describe, expect, it } from "vitest"
import { clampViewport, timelineReducer } from "../use-trace-timeline"
import type { TimelineState } from "../trace-timeline-types"
import { MIN_VISIBLE_ABS_MS } from "../trace-timeline-types"

const TRACE_START = 0
const TRACE_END = 10_000 // 10s trace

function baseState(viewport = { startMs: 0, endMs: 10_000 }): TimelineState {
	return {
		viewport,
		focusedIndex: 3,
		searchQuery: "db",
		expandedSpanIds: new Set(["a", "b"]),
	}
}

describe("clampViewport min-visible floor", () => {
	it("floors a zero-width window to traceDuration * 0.0002 for a 10s trace", () => {
		// 10_000 * 0.0002 = 2ms, which beats the absolute floor of 0.1ms
		const vp = clampViewport({ startMs: 5_000, endMs: 5_000 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2, 6)
		expect(vp.startMs).toBeCloseTo(5_000, 6)
	})

	it("never collapses below the absolute floor on a tiny trace", () => {
		// 100ms trace → 100 * 0.0002 = 0.02ms, so the absolute floor (0.1ms) wins
		const vp = clampViewport({ startMs: 50, endMs: 50 }, 0, 100)
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
	})

	it("caps an over-wide window at traceDuration * 1.1", () => {
		const vp = clampViewport({ startMs: -50_000, endMs: 50_000 }, TRACE_START, TRACE_END)
		expect(vp.endMs - vp.startMs).toBeCloseTo(11_000, 6)
	})

	it("keeps a normal window untouched", () => {
		const vp = clampViewport({ startMs: 2_000, endMs: 4_000 }, TRACE_START, TRACE_END)
		expect(vp.startMs).toBeCloseTo(2_000, 6)
		expect(vp.endMs).toBeCloseTo(4_000, 6)
	})
})

describe("ZOOM_TO_RANGE", () => {
	it("zooms to the dragged window without extra padding", () => {
		const next = timelineReducer(baseState(), {
			type: "ZOOM_TO_RANGE",
			startMs: 2_000,
			endMs: 3_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.startMs).toBeCloseTo(2_000, 6)
		expect(next.viewport.endMs).toBeCloseTo(3_000, 6)
	})

	it("normalizes a reversed (right-to-left) drag", () => {
		const next = timelineReducer(baseState(), {
			type: "ZOOM_TO_RANGE",
			startMs: 3_000,
			endMs: 2_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.startMs).toBeCloseTo(2_000, 6)
		expect(next.viewport.endMs).toBeCloseTo(3_000, 6)
	})

	it("applies the min-visible floor to a too-small drag", () => {
		const next = timelineReducer(baseState(), {
			type: "ZOOM_TO_RANGE",
			startMs: 5_000,
			endMs: 5_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.viewport.endMs - next.viewport.startMs).toBeCloseTo(2, 6)
	})

	it("leaves unrelated state fields intact", () => {
		const prev = baseState()
		const next = timelineReducer(prev, {
			type: "ZOOM_TO_RANGE",
			startMs: 1_000,
			endMs: 8_000,
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
		})
		expect(next.focusedIndex).toBe(prev.focusedIndex)
		expect(next.searchQuery).toBe(prev.searchQuery)
		expect(next.expandedSpanIds).toBe(prev.expandedSpanIds)
	})
})
