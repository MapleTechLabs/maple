import { describe, expect, it } from "vitest"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { chartUnitFromOtel } from "./otel-units"

describe("chartUnitFromOtel", () => {
	it.each([
		["ns", "", "duration_ns"],
		["us", "", "duration_us"],
		["ms", "", "duration_ms"],
		["s", "", "duration_s"],
		[" s ", "", "duration_s"],
		["By", "", "bytes"],
		["bytes", "", "bytes"],
		["%", "", "percent_100"],
		["1", "system.cpu.utilization", "percent"],
		["1", "process.cpu.usage", "percent"],
		["1", "process.threads", undefined],
		["1", "container.cpu.utilization", "percent_100"],
		["1", "container.memory.percent", "percent_100"],
		["{request}/s", "", undefined],
		["1/s", "", undefined],
		["{request}", "", undefined],
		["KiBy", "", undefined],
		["MiBy", "", undefined],
		["By/s", "", undefined],
		["", "", undefined],
		["toString", "", undefined],
	])("maps %j (metric %j) to %j", (unit, metricName, expected) => {
		expect(chartUnitFromOtel(unit, metricName)).toBe(expected)
	})

	it("reads a ratio as a percentage and a 0-100 value as-is", () => {
		expect(formatValueByUnit(0.42, chartUnitFromOtel("1", "system.memory.utilization"))).toBe("42.0%")
		expect(formatValueByUnit(42, chartUnitFromOtel("%"))).toBe("42.0%")
		expect(formatValueByUnit(42, chartUnitFromOtel("1", "container.cpu.utilization"))).toBe("42.0%")
	})
})
