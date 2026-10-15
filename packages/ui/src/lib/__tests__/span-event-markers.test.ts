import { describe, expect, it } from "vitest"
import { spanEventMarkers } from "../span-event-markers"

describe("spanEventMarkers", () => {
	it("places each event at its share of the span duration", () => {
		const markers = spanEventMarkers(
			[
				{ name: "cache.miss", offsetMs: 25 },
				{ name: "exception", offsetMs: 75 },
			],
			100,
		)
		expect(markers.map((m) => [m.name, m.percent, m.isException])).toEqual([
			["cache.miss", 25, false],
			["exception", 75, true],
		])
	})

	it("pins events outside the span to the nearest edge", () => {
		const markers = spanEventMarkers(
			[
				{ name: "early", offsetMs: -3 },
				{ name: "late", offsetMs: 140 },
			],
			100,
		)
		expect(markers.map((m) => m.percent)).toEqual([0, 100])
		expect(markers.map((m) => m.offsetMs)).toEqual([-3, 140])
	})

	it("puts every event at the start of a zero-duration span", () => {
		expect(spanEventMarkers([{ name: "log", offsetMs: 0.2 }], 0).map((m) => m.percent)).toEqual([0])
	})
})
