import { describe, expect, it } from "vitest"
import { spanEventMarkers } from "../span-event-markers"

describe("spanEventMarkers", () => {
	it("places each event at its time on the trace axis", () => {
		const markers = spanEventMarkers(
			[
				{ name: "cache.miss", offsetMs: 25 },
				{ name: "exception", offsetMs: 75 },
			],
			1000,
			100,
		)
		expect(markers.map((m) => [m.name, m.atMs, m.isException])).toEqual([
			["cache.miss", 1025, false],
			["exception", 1075, true],
		])
	})

	it("keeps the event time of a span that runs far past the visible window", () => {
		// Zoomed in on 0-10 ms: the bar of this 0-10 s span is clamped to the view, the
		// marker must still sit at 5 ms, not at the middle of the clamped box.
		const [marker] = spanEventMarkers([{ name: "retry", offsetMs: 5 }], 0, 10_000)
		expect(marker?.atMs).toBe(5)
	})

	it("pins events outside the span to the nearest edge", () => {
		const markers = spanEventMarkers(
			[
				{ name: "early", offsetMs: -3 },
				{ name: "late", offsetMs: 140 },
			],
			1000,
			100,
		)
		expect(markers.map((m) => m.atMs)).toEqual([1000, 1100])
		expect(markers.map((m) => m.offsetMs)).toEqual([-3, 140])
		expect(markers.map((m) => m.offsetLabel)).toEqual(["-3.0ms", "+140.0ms"])
	})

	it("puts every event at the start of a zero-duration span", () => {
		expect(spanEventMarkers([{ name: "log", offsetMs: 0.2 }], 40, 0).map((m) => m.atMs)).toEqual([40])
	})
})
