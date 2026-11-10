import { describe, expect, it } from "vitest"
import { dayKey, dayLabel } from "./day-label"

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

describe("dayKey", () => {
	it("splits days at the zone's midnight, not UTC's", () => {
		const lateUtc = Date.parse("2025-03-30T22:10:00Z")
		const earlierUtc = Date.parse("2025-03-30T21:50:00Z")
		// 00:10 and 23:50 in Stockholm: two days there, one day in UTC.
		expect(dayKey(lateUtc, "Europe/Stockholm")).not.toBe(dayKey(earlierUtc, "Europe/Stockholm"))
		expect(dayKey(lateUtc, "UTC")).toBe(dayKey(earlierUtc, "UTC"))
		expect(dayKey(lateUtc, "Asia/Tokyo")).not.toBe(
			dayKey(Date.parse("2025-03-30T14:00:00Z"), "Asia/Tokyo"),
		)
	})
})
