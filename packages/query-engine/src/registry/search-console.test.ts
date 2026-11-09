import { describe, expect, it } from "vitest"
import { searchConsoleDays } from "./search-console"

describe("searchConsoleDays", () => {
	const window = { startTime: "2026-10-25 00:00:00", endTime: "2026-11-08 14:30:00" }

	it("covers whole days and an equal run of days before them", () => {
		expect(searchConsoleDays(window)).toEqual({
			startDate: "2026-10-25 00:00:00",
			endDate: "2026-11-08 00:00:00",
			endOfDay: "2026-11-08 23:59:59",
			previousStartDate: "2026-10-10 00:00:00",
		})
	})

	it("ends at the last complete day and compares against a period of the capped length", () => {
		expect(searchConsoleDays({ ...window, completeThrough: "2026-11-05" })).toEqual({
			startDate: "2026-10-25 00:00:00",
			endDate: "2026-11-05 00:00:00",
			endOfDay: "2026-11-05 23:59:59",
			previousStartDate: "2026-10-13 00:00:00",
		})
	})

	it("covers no day when the whole window is past the last complete day", () => {
		const days = searchConsoleDays({ ...window, completeThrough: "2026-10-20" })
		expect(days.endDate < days.startDate).toBe(true)
		expect(days.previousStartDate).toBe(days.startDate)
	})
})
