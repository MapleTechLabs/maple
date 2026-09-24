import { describe, expect, it } from "vitest"

import { percentilePresets, toLogBuckets } from "./range-distribution"

// The half-octave case is covered through the replays wrapper
// (`replays-filter-sidebar.test.ts`); these are the parts only other units reach.

describe("toLogBuckets", () => {
	it("rebuilds octave buckets over a count with whole bounds and no gaps", () => {
		const buckets = toLogBuckets(
			[
				{ floor: 16, count: 2 },
				{ floor: 1, count: 5 },
			],
			1,
		)
		expect(buckets).toEqual([
			{ from: 1, to: 2, count: 5 },
			{ from: 2, to: 4, count: 0 },
			{ from: 4, to: 8, count: 0 },
			{ from: 8, to: 16, count: 0 },
			{ from: 16, to: 32, count: 2 },
		])
	})

	it("places floors below 1, as a cost's are", () => {
		// $0.0221 is the half-octave floor 2^-5.5 the warehouse writes for $0.03.
		const [bucket] = toLogBuckets([{ floor: 2 ** -5.5, count: 1 }], 2)
		expect(bucket!.from).toBeCloseTo(0.0221, 4)
		expect(bucket!.to).toBeCloseTo(0.03125, 5)
	})
})

describe("percentilePresets", () => {
	it("names each percentile with the threshold it resolves to", () => {
		expect(percentilePresets(47.4, 2647, "s")).toEqual([
			{ key: "p50", label: "> p50", value: "47s", min: 47 },
			{ key: "p95", label: "> p95", value: "44m", min: 2640 },
		])
	})

	it("rounds a count to two significant figures and keeps it whole", () => {
		expect(percentilePresets(48_213, 7.5, "count").map((preset) => preset.min)).toEqual([48_000, 8])
	})

	it("rounds dollars to two significant figures", () => {
		expect(percentilePresets(0.04372, 1.234, "usd")).toEqual([
			{ key: "p50", label: "> p50", value: "$0.04", min: 0.044 },
			{ key: "p95", label: "> p95", value: "$1.20", min: 1.2 },
		])
	})

	it("skips thresholds too small to narrow anything, and a p95 equal to the p50", () => {
		expect(percentilePresets(0.4, 0.2, "s")).toEqual([])
		// A count of 1 is every session the histogram holds.
		expect(percentilePresets(1, 3, "count").map((preset) => preset.key)).toEqual(["p95"])
		expect(percentilePresets(12, 12.4, "count").map((preset) => preset.key)).toEqual(["p50"])
	})
})
