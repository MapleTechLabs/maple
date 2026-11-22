import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { occurrencePointsOf } from "./view-chart"

// The occurrence chart draws every bucket of the window, quiet ones as zero, so a sparse issue's
// axis and markers still span the window.

const HOUR = 3_600_000
const window = {
	startMs: Date.parse("2026-11-01T09:00:00.000Z"),
	endMs: Date.parse("2026-11-01T12:00:00.000Z"),
	bucketMs: HOUR,
	bucketSeconds: 3600,
}

describe("occurrence points", () => {
	test("one busy bucket comes back among the window's quiet ones", () => {
		const points = occurrencePointsOf([{ bucket: "2026-11-01T10:00:00.000Z", count: 7 }], window)
		expect(Arr.map(points, (point) => [point.bucket, point.count])).toEqual([
			["2026-11-01T09:00:00.000Z", 0],
			["2026-11-01T10:00:00.000Z", 7],
			["2026-11-01T11:00:00.000Z", 0],
		])
	})

	test("a window that starts inside a bucket keeps that bucket's count", () => {
		const points = occurrencePointsOf([{ bucket: "2026-11-01T09:00:00.000Z", count: 3 }], {
			...window,
			startMs: window.startMs + 5 * 60_000,
		})
		expect(points[0]).toEqual({ bucket: "2026-11-01T09:00:00.000Z", count: 3 })
		expect(points).toHaveLength(3)
	})
})
