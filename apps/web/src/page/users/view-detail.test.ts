import { describe, expect, it } from "vitest"
import { dayLabel, indexedTabState } from "./view-detail"

// Stockholm skipped 02:00-03:00 on 30 Mar 2025, so that local day was 23 hours long.
const clock = { nowMs: Date.parse("2025-03-30T22:30:00Z"), timeZone: "Europe/Stockholm" }

describe("dayLabel", () => {
	it("calls the short day before a spring-forward night yesterday", () => {
		expect(dayLabel(Date.parse("2025-03-30T10:00:00Z"), clock)).toBe("Yesterday")
	})

	it("names the day before that by date", () => {
		expect(dayLabel(Date.parse("2025-03-29T12:00:00Z"), clock)).toBe("Sat 29 Mar")
	})

	it("calls the current local day today", () => {
		expect(dayLabel(Date.parse("2025-03-30T22:10:00Z"), clock)).toBe("Today")
	})
})

describe("indexedTabState", () => {
	it("tells a warehouse without the per-user rollup apart from a user with no rows", () => {
		expect(indexedTabState(null, [])).toBe("unindexed")
		expect(indexedTabState(0, [])).toBe("empty")
		expect(indexedTabState(3, [{}])).toBe("rows")
	})
})
