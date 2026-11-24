import { describe, expect, it } from "vitest"

import { resolveTimeRangeAt } from "./time-range"

const nowMs = Date.parse("2026-11-23T14:05:50Z")
const options = { timeZone: "UTC", snap: false }

describe("resolveTimeRangeAt", () => {
	it("keeps an explicit warehouse-shaped pair as written", () => {
		expect(
			resolveTimeRangeAt(nowMs, "2026-11-23 13:00:00", "2026-11-23 14:00:00.250", "1h", options),
		).toEqual({ startTime: "2026-11-23 13:00:00", endTime: "2026-11-23 14:00:00.250" })
	})

	it("converts an ISO pair from a pasted link to the warehouse shape", () => {
		expect(
			resolveTimeRangeAt(nowMs, "2026-11-23T13:00:00.000Z", "2026-11-23T14:00:00Z", "1h", options),
		).toEqual({ startTime: "2026-11-23 13:00:00", endTime: "2026-11-23 14:00:00" })
	})

	it("falls back to the preset when a bound is not a date", () => {
		expect(resolveTimeRangeAt(nowMs, "yesterday-ish", "2026-11-23 14:00:00", "1h", options)).toEqual({
			startTime: "2026-11-23 13:05:50",
			endTime: "2026-11-23 14:05:50",
		})
	})
})
