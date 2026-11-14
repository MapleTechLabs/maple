import { describe, expect, test } from "vitest"
import { timeseriesYAxis } from "./timeseries"

// A share that can fall far below zero but never pass 100%: an error budget.
const rows = [{ budget: 1 }, { budget: 0.2 }, { budget: -19 }]

describe("timeseriesYAxis with a hard max", () => {
	test("tops out at the max where nicing alone would round past it", () => {
		const free = timeseriesYAxis({ rows, visibleKeys: ["budget"], unit: "percent" })
		expect(free.domain[1]).toBeGreaterThan(1)
		const capped = timeseriesYAxis({ rows, visibleKeys: ["budget"], unit: "percent", max: 1 })
		expect(capped.domain[1]).toBe(1)
		expect(capped.domain[0]).toBeLessThanOrEqual(-19)
	})

	test("labels its top tick as the max and zero with the unit when asked", () => {
		const axis = timeseriesYAxis({
			rows: [{ budget: 1 }, { budget: -0.35 }],
			visibleKeys: ["budget"],
			unit: "percent",
			max: 1,
			zeroLabel: "0%",
		}).y.axis.ticks
		expect(axis.values?.at(-1)).toBe(1)
		expect(axis.format(1)).toBe("100%")
		expect(axis.format(0)).toBe("0%")
	})
})
