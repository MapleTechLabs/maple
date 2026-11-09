import { describe, expect, it } from "vitest"
import { completeThrough, historyFloor, pacificToday, searchConsoleCoverage } from "./search-console"

describe("completeThrough", () => {
	it("stops at yesterday while the watermark holds today's partial day", () => {
		expect(completeThrough("2026-11-08", "2026-11-08")).toBe("2026-11-07")
	})

	it("is the watermark when the import lags behind yesterday", () => {
		expect(completeThrough("2026-11-03", "2026-11-08")).toBe("2026-11-03")
	})

	it("crosses a month boundary", () => {
		expect(completeThrough("2026-12-01", "2026-12-01")).toBe("2026-11-30")
	})
})

describe("pacificToday", () => {
	it("is still the previous day in Pacific time early in the UTC morning", () => {
		expect(pacificToday(Date.parse("2026-11-08T05:00:00Z"))).toBe("2026-11-07")
	})
})

describe("searchConsoleCoverage", () => {
	const week = {
		startTime: "2026-11-01 00:00:00",
		endTime: "2026-11-08 13:00:00",
		completeThrough: "2026-11-07",
	}

	it("covers whole days to the last complete one and the same run before them", () => {
		const coverage = searchConsoleCoverage(week, "2026-10-01", "2026-11-08")
		expect([coverage.startDay, coverage.endDay, coverage.previousStartDay]).toEqual([
			"2026-11-01",
			"2026-11-07",
			"2026-10-25",
		])
		expect([coverage.current, coverage.previous]).toEqual([true, true])
	})

	it("marks the previous period importing when it starts before the backfill frontier", () => {
		const coverage = searchConsoleCoverage(week, "2026-10-26", "2026-11-08")
		expect([coverage.current, coverage.previous]).toEqual([true, false])
	})

	it("marks both importing when the window itself starts before the frontier", () => {
		const coverage = searchConsoleCoverage(week, "2026-11-03", "2026-11-08")
		expect([coverage.current, coverage.previous]).toEqual([false, false])
	})

	it("counts history complete once backfill reached Google's floor", () => {
		const coverage = searchConsoleCoverage(
			{ startTime: "2025-06-01 00:00:00", endTime: "2025-08-01 00:00:00" },
			historyFloor("2026-11-08"),
			"2026-11-08",
		)
		expect([coverage.current, coverage.previous]).toEqual([true, true])
	})

	it("treats a property with no backfill frontier yet as importing", () => {
		expect(searchConsoleCoverage(week, null, "2026-11-08").current).toBe(false)
	})
})
