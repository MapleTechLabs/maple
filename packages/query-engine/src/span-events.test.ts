import { describe, expect, it } from "vitest"
import { parseSpanEvents } from "./span-events"

const raw = (overrides: Partial<Parameters<typeof parseSpanEvents>[0]> = {}) => ({
	spanStart: "2026-03-20 08:00:00.000100000",
	eventsTimestamp: JSON.stringify(["2026-03-20 08:00:01.250300000", "2026-03-20 08:00:00.000600000"]),
	eventsName: JSON.stringify(["exception", "cache.miss"]),
	eventsAttributes: JSON.stringify([{ "exception.type": "TypeError" }, { key: "user:1" }]),
	...overrides,
})

describe("parseSpanEvents", () => {
	it("zips the parallel arrays and sorts by time", () => {
		const events = parseSpanEvents(raw())
		expect(events.map((e) => e.name)).toEqual(["cache.miss", "exception"])
		expect(events[0]?.attributes).toEqual({ key: "user:1" })
		expect(events[1]?.attributes).toEqual({ "exception.type": "TypeError" })
		expect(events[1]?.timestamp).toBe("2026-03-20T08:00:01.250Z")
	})

	it("keeps sub-millisecond precision in offsets", () => {
		const [first, second] = parseSpanEvents(raw())
		expect(first?.offsetMs).toBeCloseTo(0.5, 9)
		expect(second?.offsetMs).toBeCloseTo(1250.2, 9)
	})

	it("tolerates missing names and attributes for an event", () => {
		const events = parseSpanEvents(
			raw({ eventsName: JSON.stringify(["only"]), eventsAttributes: JSON.stringify([]) }),
		)
		expect(events.map((e) => [e.name, e.attributes])).toEqual([
			["", {}],
			["only", {}],
		])
	})

	it("reads times and names alone when attributes were not selected", () => {
		const { eventsAttributes: _, ...withoutAttributes } = raw()
		const events = parseSpanEvents(withoutAttributes)
		expect(events.map((e) => [e.name, e.attributes])).toEqual([
			["cache.miss", {}],
			["exception", {}],
		])
	})

	it("returns no events for empty or undecodable arrays", () => {
		expect(parseSpanEvents(raw({ eventsTimestamp: "[]" }))).toEqual([])
		expect(parseSpanEvents(raw({ eventsTimestamp: "not json" }))).toEqual([])
	})
})
