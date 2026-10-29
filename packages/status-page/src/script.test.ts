import { dayState, type StatusPageDayBar } from "@maple/domain/status-page"
import { describe, expect, it } from "vitest"
import { FIXTURE_NOW, makeComponent, makeDays, makeSnapshot } from "./fixtures"
import { dayTitle, formatDay, formatPercent } from "./format"
import {
	calendarMonthCount,
	monthBefore,
	monthCells,
	monthLabel,
	shiftDay,
	windowBounds,
	windowCount,
} from "./history"
import { PAGE_SCRIPT_LOGIC } from "./script"

interface ScriptLogic {
	readonly shift: (day: string, offset: number) => string
	readonly mlabel: (day: string) => string
	readonly fday: (day: string) => string
	readonly bounds: (length: number, page: number) => { from: number; to: number }
	readonly state: (counts: ReadonlyArray<number> | 0) => string
	readonly tip: (day: string, counts: ReadonlyArray<number> | 0) => string
	readonly pct: (percent: number) => string
	readonly cells: (year: number, month: number) => ReadonlyArray<number>
	readonly mback: (day: string, back: number) => string
}

// The shipped script source, evaluated as the browser would, to hold it to the server's answers.
const logic: ScriptLogic = new Function(
	`${PAGE_SCRIPT_LOGIC}return{shift,mlabel,fday,bounds,state,tip,pct,cells,mback}`,
)()

const DAYS = ["2026-10-28", "2026-03-01", "2024-02-29", "2026-01-01", "2025-12-31"]
const counts = (bar: StatusPageDayBar): ReadonlyArray<number> | 0 =>
	bar.checks === 0 ? 0 : [bar.checks, bar.failures, bar.downChecks]

describe("page script logic", () => {
	it("moves days and labels them as the server does, across months, years and leap days", () => {
		for (const day of DAYS) {
			for (const offset of [-400, -90, -1, 0, 1, 31]) {
				expect(logic.shift(day, offset)).toBe(shiftDay(day, offset))
			}
			expect(logic.mlabel(day)).toBe(monthLabel(day))
			expect(logic.fday(day)).toBe(formatDay(day))
		}
	})

	it("pages windows of 90 days back from the newest", () => {
		expect(windowBounds(365, 0)).toEqual({ from: 275, to: 365 })
		expect(windowBounds(365, 4)).toEqual({ from: -85, to: 5 })
		for (const page of [0, 1, 2, 3, 4]) {
			expect(logic.bounds(365, page)).toEqual(windowBounds(365, page))
		}
	})

	it("titles and colours each bar, and rounds uptime, as the server does", () => {
		const bars = makeDays(FIXTURE_NOW, { 0: "none", 1: "degraded", 2: "down" })
		for (const bar of bars.slice(0, 4)) {
			const state = dayState(bar)
			expect(logic.state(counts(bar))).toBe(state)
			expect(logic.tip(bar.day, counts(bar))).toBe(dayTitle(bar, state))
		}
		for (const percent of [100, 99.999, 99.97, 99.9, 50, 0]) {
			expect(logic.pct(percent)).toBe(formatPercent(percent))
		}
	})

	it("lays out Monday-first month grids and steps back through months as the server does", () => {
		// October 2026 starts on a Thursday and has 31 days.
		const october = monthCells(2026, 10)
		expect(october.slice(0, 4)).toEqual([0, 0, 0, 1])
		expect(october).toHaveLength(35)
		expect(october.filter((date) => date > 0)).toHaveLength(31)
		// February 2021 starts on a Monday and fills exactly four weeks.
		expect(monthCells(2021, 2)).toHaveLength(28)
		for (const [year, month] of [
			[2026, 10],
			[2021, 2],
			[2024, 2],
			[2026, 6],
		] as const) {
			expect(logic.cells(year, month)).toEqual(monthCells(year, month))
		}
		for (const back of [0, 1, 9, 10, 12, 13]) {
			expect(logic.mback("2026-10-28", back)).toBe(monthBefore("2026-10-28", back))
		}
		expect(monthBefore("2026-10-28", 10)).toBe("2025-12")
	})
})

describe("history bounds", () => {
	it("pages back only as far as the oldest checked day", () => {
		const unchecked = (count: number) =>
			Object.fromEntries(Array.from({ length: count }, (_, index) => [index, "none" as const]))
		const withDays = (blank: number) =>
			makeSnapshot({
				components: [makeComponent(0, { days: makeDays(FIXTURE_NOW, unchecked(blank), 365) })],
			}).components
		expect(windowCount([])).toBe(1)
		expect(windowCount(withDays(365))).toBe(1)
		expect(windowCount(withDays(275))).toBe(1)
		expect(windowCount(withDays(274))).toBe(2)
		expect(windowCount(withDays(0))).toBe(5)
	})

	it("offers the months back to the one holding the oldest day of history", () => {
		// 365 days back from Oct 28, 2026 reaches Oct 29, 2025.
		expect(calendarMonthCount("2026-10-28")).toBe(13)
		expect(calendarMonthCount("2026-12-31")).toBe(12)
	})
})
