import { describe, expect, it } from "vitest"

import { findNearestSeriesKey } from "../nearest-series"

describe("findNearestSeriesKey", () => {
	const ys = { s1: 10, s2: 50, s3: 120 }

	it("returns the series whose active point is closest to the pointer", () => {
		expect(findNearestSeriesKey(ys, ["s1", "s2", "s3"], 48, 24)).toBe("s2")
		expect(findNearestSeriesKey(ys, ["s1", "s2", "s3"], 12, 24)).toBe("s1")
	})

	it("returns undefined when the pointer is farther than the threshold from every line", () => {
		expect(findNearestSeriesKey(ys, ["s1", "s2", "s3"], 85, 24)).toBeUndefined()
	})

	it("returns undefined when the pointer Y is missing or non-finite", () => {
		expect(findNearestSeriesKey(ys, ["s1", "s2"], undefined, 24)).toBeUndefined()
		expect(findNearestSeriesKey(ys, ["s1", "s2"], Number.NaN, 24)).toBeUndefined()
	})

	it("only considers candidate keys, ignoring hidden / absent series", () => {
		// s1 is closest overall but excluded from candidates -> picks s2.
		expect(findNearestSeriesKey(ys, ["s2", "s3"], 14, 50)).toBe("s2")
	})

	it("skips candidates without a recorded Y position", () => {
		expect(findNearestSeriesKey({ s2: 50 }, ["s1", "s2"], 55, 24)).toBe("s2")
	})

	it("includes points exactly at the threshold distance", () => {
		expect(findNearestSeriesKey({ s1: 100 }, ["s1"], 124, 24)).toBe("s1")
		expect(findNearestSeriesKey({ s1: 100 }, ["s1"], 125, 24)).toBeUndefined()
	})
})
