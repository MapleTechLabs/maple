import { Option, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { placeBar, timelineDays, zonedDayStart } from "./shift-timeline"

const HOUR = 3_600_000

describe("shift timeline layout", () => {
	test("a bar is placed as a share of the range and clipped to it", () => {
		expect(placeBar(0, 100, 25, 50)).toEqual(Option.some({ leftPct: 25, widthPct: 25 }))
		expect(placeBar(0, 100, -50, 10)).toEqual(Option.some({ leftPct: 0, widthPct: 10 }))
		expect(placeBar(0, 100, 100, 150)).toEqual(Option.none())
	})

	test("days follow the zone's wall clock: the Berlin fall-back Sunday is 25 hours wide", () => {
		const from = Date.parse("2026-10-22T22:00:00.000Z") // Fri 23 Oct, 00:00 in Berlin
		const to = from + 7 * 24 * HOUR + HOUR
		const days = timelineDays(from, to, "Europe/Berlin")
		expect(Arr.map(days, (day) => `${day.weekday} ${day.dayOfMonth}`)).toEqual([
			"Fri 23",
			"Sat 24",
			"Sun 25",
			"Mon 26",
			"Tue 27",
			"Wed 28",
			"Thu 29",
		])
		const sunday = days[2]
		expect(sunday === undefined ? 0 : (sunday.endMs - sunday.startMs) / HOUR).toBe(25)
		expect(Arr.reduce(days, 0, (sum, day) => sum + day.widthPct)).toBeCloseTo(100, 6)
	})

	test("a day starts at the zone's midnight, not UTC's", () => {
		const noonInNewYork = Date.parse("2026-11-10T17:00:00.000Z")
		expect(new Date(zonedDayStart(noonInNewYork, "America/New_York")).toISOString()).toBe(
			"2026-11-10T05:00:00.000Z",
		)
		expect(new Date(zonedDayStart(noonInNewYork, "America/New_York", 1)).toISOString()).toBe(
			"2026-11-11T05:00:00.000Z",
		)
	})
})
