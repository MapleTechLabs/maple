import { describe, expect, it } from "vitest"
import { pivotSeries } from "./chart-series"

const window = {
	startMs: Date.parse("2026-07-30T14:00:00Z"),
	endMs: Date.parse("2026-07-30T14:05:30Z"),
	bucketSeconds: 60,
}

describe("pivotSeries", () => {
	it("zero-fills every bucket for counts so curves never bridge a gap", () => {
		const rows = pivotSeries(
			[
				{ bucket: "2026-07-30 14:01:00", series: "GET /", value: 3 },
				{ bucket: "2026-07-30 14:04:00", series: "GET /", value: 5 },
			],
			window,
			"zero",
		)
		expect(rows.map((row) => row["GET /"])).toEqual([0, 3, 0, 0, 5, 0])
		expect(rows[0]?.bucket).toBe("2026-07-30T14:00:00.000Z")
	})

	it("keeps only reported buckets for averages, where an empty bucket is unknown", () => {
		const rows = pivotSeries(
			[
				{ bucket: "2026-07-30 14:01:00", series: "api", value: 0.4 },
				{ bucket: "2026-07-30 14:04:00", series: "api", value: 0.6 },
			],
			window,
			"sparse",
		)
		expect(rows).toEqual([
			{ bucket: "2026-07-30T14:01:00.000Z", api: 0.4 },
			{ bucket: "2026-07-30T14:04:00.000Z", api: 0.6 },
		])
	})

	it("returns nothing to plot when there are no points", () => {
		expect(pivotSeries([], window, "zero")).toEqual([])
	})
})
