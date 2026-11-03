import { describe, expect, it } from "vitest"
import { checkHealth, formatMs, formatShare, medianOf } from "./uptime-derive"
import { Array as Arr } from "effect"

describe("checkHealth", () => {
	const ok = (latencyMs: number | null) => checkHealth({ total: 10, failed: 0, latencyMs }, 200)

	it("reads a bucket by how much of it failed before latency", () => {
		expect(
			Arr.map([0, 1, 4, 5, 10], (failed) => checkHealth({ total: 10, failed, latencyMs: 2000 }, 200)),
		).toEqual(["slow", "someFailed", "someFailed", "mostlyFailed", "mostlyFailed"])
	})

	it("grades passing checks against the median: under 1.5x fast, under 2x slower, over slow", () => {
		expect(Arr.map([200, 300, 301, 400, 401], ok)).toEqual(["fast", "fast", "slower", "slower", "slow"])
	})

	it("treats a single failed check as mostly failed, and no checks as none", () => {
		expect(checkHealth({ total: 1, failed: 1, latencyMs: 50 }, 200)).toBe("mostlyFailed")
		expect(checkHealth({ total: 0, failed: 0, latencyMs: null }, 200)).toBe("none")
	})

	it("calls a passing check fast when there is no latency or median to compare", () => {
		expect([ok(null), checkHealth({ total: 3, failed: 0, latencyMs: 900 }, null)]).toEqual([
			"fast",
			"fast",
		])
	})
})

describe("medianOf", () => {
	it("takes the middle value, the mean of the middle two, or null with none", () => {
		expect([medianOf([5, 1, 3]), medianOf([4, 1, 3, 2]), medianOf([])]).toEqual([3, 2.5, null])
	})
})

describe("formatShare", () => {
	it("drops the decimals for every whole share, despite floating point", () => {
		expect(Arr.map([11 / 20, 7 / 100, 1, 0], formatShare)).toEqual(["55%", "7%", "100%", "0%"])
	})

	it("keeps two decimals otherwise, and a dash with no checks", () => {
		expect(Arr.map([0.9958, 2 / 3, null], formatShare)).toEqual(["99.58%", "66.67%", "–"])
	})
})

describe("formatMs", () => {
	it("switches to seconds where milliseconds would round to 1000", () => {
		expect(formatMs(999.4)).toBe("999 ms")
		expect(formatMs(999.6)).toBe("1.00 s")
	})
})
