import { describe, expect, it } from "vitest"
import { chartUnitFromOtel, humanizeUnit, isCounter, isMetricType } from "./units"

describe("humanizeUnit", () => {
	it("spells out UCUM codes", () => {
		expect(humanizeUnit("By")).toBe("bytes")
		expect(humanizeUnit("s")).toBe("seconds")
		expect(humanizeUnit("By/s")).toBe("bytes/s")
	})

	it("drops the braces of an annotation", () => {
		expect(humanizeUnit("{request}")).toBe("requests")
		expect(humanizeUnit("{packets}")).toBe("packets")
	})

	it("shows a dimensionless 1 as a percentage only for ratio-named metrics", () => {
		expect(humanizeUnit("1", "system.cpu.utilization")).toBe("%")
		expect(humanizeUnit("1", "process.threads")).toBe("")
		expect(humanizeUnit("")).toBe("")
	})
})

describe("chartUnitFromOtel", () => {
	it("maps durations, bytes and ratios onto the chart formatter", () => {
		expect(chartUnitFromOtel("s")).toBe("duration_s")
		expect(chartUnitFromOtel("ms")).toBe("duration_ms")
		expect(chartUnitFromOtel("By")).toBe("bytes")
		expect(chartUnitFromOtel("1", "system.memory.utilization")).toBe("percent")
		expect(chartUnitFromOtel("{request}")).toBeUndefined()
	})
})

describe("metric type helpers", () => {
	it("decodes only the four metric types", () => {
		expect(isMetricType("gauge")).toBe(true)
		expect(isMetricType("summary")).toBe(false)
	})

	it("treats only monotonic sums as counters", () => {
		expect(isCounter({ metricType: "sum", isMonotonic: true })).toBe(true)
		expect(isCounter({ metricType: "sum", isMonotonic: false })).toBe(false)
		expect(isCounter({ metricType: "gauge", isMonotonic: true })).toBe(false)
	})
})
