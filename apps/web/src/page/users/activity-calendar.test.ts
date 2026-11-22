import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import type { UserActivityDay } from "./data"
import { calendarDays, calendarFacts, dayLine, dayRange, dayTooltip, levelsOf } from "./activity-calendar"

const NOW = Date.UTC(2026, 10, 22, 13, 30)

const active = (day: string, requests = 10, extra: Partial<UserActivityDay> = {}): UserActivityDay => ({
	day,
	requests,
	failedRequests: 0,
	errorLogs: 0,
	sessions: 0,
	events: 0,
	...extra,
})

const byDay = (days: ReadonlyArray<UserActivityDay>) =>
	new Map(Arr.map(days, (day) => [day.day, day] as const))

describe("the calendar's days", () => {
	it("covers a year of UTC days ending today, across a month and a year boundary", () => {
		const days = calendarDays(NOW)
		expect(days).toHaveLength(365)
		expect(days[0]).toBe("2025-11-23")
		expect(days[364]).toBe("2026-11-22")
		expect(calendarDays(Date.UTC(2026, 0, 1, 2), 3)).toEqual(["2025-12-30", "2025-12-31", "2026-01-01"])
	})

	it("scopes a square's link to its whole UTC day", () => {
		expect(dayRange("2026-02-28")).toEqual({
			startTime: "2026-02-28 00:00:00",
			endTime: "2026-03-01 00:00:00",
		})
	})
})

describe("shades", () => {
	it("splits the user's own active days into quartiles, so one huge day keeps the rest visible", () => {
		const level = levelsOf([1, 2, 3, 4, 5, 6, 7, 8, 100_000])
		// Cut at 3, 5 and 7: the 100,000 day takes the top shade alone.
		expect(Arr.map([0, 1, 4, 6, 8, 100_000], level)).toEqual([0, 1, 2, 3, 4, 4])
	})

	it("shades a user's only active day the lightest", () => {
		expect(levelsOf([12])(12)).toBe(1)
	})
})

describe("habits", () => {
	const days = calendarDays(NOW, 10)

	it("keeps a streak that ran through yesterday while today is still empty", () => {
		const facts = calendarFacts(
			days,
			byDay([active(days[6] ?? ""), active(days[7] ?? ""), active(days[8] ?? "")]),
		)
		expect(facts.currentStreak).toBe(3)
		expect(facts.longestStreak).toBe(3)
		expect(facts.activeDays).toBe(3)
	})

	it("breaks the streak on a day with nothing, and finds the longest run before it", () => {
		const facts = calendarFacts(
			days,
			byDay([
				active(days[0] ?? ""),
				active(days[1] ?? ""),
				active(days[2] ?? ""),
				active(days[9] ?? ""),
			]),
		)
		expect(facts.currentStreak).toBe(1)
		expect(facts.longestStreak).toBe(3)
	})

	it("counts a day with only an error as a day with an error, not an active one", () => {
		const facts = calendarFacts(days, byDay([active(days[4] ?? "", 0, { errorLogs: 2 })]))
		expect(facts.errorDays).toBe(1)
		expect(facts.activeDays).toBe(0)
		expect(facts.busiestWeekday).toBeNull()
	})

	it("names the busiest weekday by everything done on it", () => {
		// 2026-11-17 is a Tuesday.
		const facts = calendarFacts(days, byDay([active("2026-11-17", 50), active("2026-11-18", 5)]))
		expect(facts.busiestWeekday).toBe(2)
	})
})

describe("a square's hover line", () => {
	it("lists what the user did that day and leaves out what they did not", () => {
		expect(dayLine("2026-11-17", active("2026-11-17", 412, { sessions: 3, failedRequests: 1 }))).toBe(
			"Tue, 17 Nov 2026: 412 requests, 3 sessions, 1 error",
		)
		expect(dayLine("2026-11-18", undefined)).toBe("Wed, 18 Nov 2026: no activity")
	})
})

describe("a square's tooltip", () => {
	it("titles it with the date and gives each kind the user did a row, flagging a day with errors", () => {
		expect(dayTooltip("2026-10-07", active("2026-10-07", 1538, { sessions: 4, errorLogs: 25 }))).toEqual({
			title: "Wed, 7 Oct 2026",
			rows: [
				{ label: "Requests", value: "1,538", tone: "neutral" },
				{ label: "Sessions", value: "4", tone: "done" },
				{ label: "Errors", value: "25", tone: "crit" },
			],
			hasErrors: true,
		})
	})

	it("has no rows for a quiet day", () => {
		expect(dayTooltip("2026-10-08", undefined)).toEqual({
			title: "Thu, 8 Oct 2026",
			rows: [],
			hasErrors: false,
		})
	})
})
