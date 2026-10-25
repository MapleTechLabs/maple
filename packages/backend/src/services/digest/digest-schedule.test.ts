import { describe, expect, it } from "vitest"

import { isDigestDue, lastDigestActivity } from "./digest-schedule"

const at = (iso: string) => Date.parse(iso)
const MONDAY = 1
const SUNDAY = 0
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

describe("isDigestDue", () => {
	it("waits for the send hour on the local clock, not the UTC one", () => {
		const berlin = { dayOfWeek: MONDAY, sendHour: 9, timezone: "Europe/Berlin" }
		// Summer time: 09:00 in Berlin is 07:00 UTC.
		expect(isDigestDue(berlin, null, at("2026-07-06T06:45:00Z"))).toBe(false)
		expect(isDigestDue(berlin, null, at("2026-07-06T07:00:00Z"))).toBe(true)
	})

	it("uses the local weekday when it differs from the UTC one", () => {
		const tokyo = { dayOfWeek: MONDAY, sendHour: 9, timezone: "Asia/Tokyo" }
		// Monday 09:00 in Tokyo is Monday 00:00 UTC; Sunday 23:59 UTC is Monday 08:59 there.
		expect(isDigestDue(tokyo, null, at("2026-07-05T23:59:00Z"))).toBe(false)
		expect(isDigestDue(tokyo, null, at("2026-07-06T00:00:00Z"))).toBe(true)
		// Monday 15:00 UTC is already Tuesday in Tokyo.
		expect(isDigestDue(tokyo, null, at("2026-07-06T15:00:00Z"))).toBe(false)

		const losAngeles = { dayOfWeek: MONDAY, sendHour: 9, timezone: "America/Los_Angeles" }
		// Monday 08:00 UTC is still 01:00 Monday in Los Angeles.
		expect(isDigestDue(losAngeles, null, at("2026-07-06T08:00:00Z"))).toBe(false)
		expect(isDigestDue(losAngeles, null, at("2026-07-06T16:00:00Z"))).toBe(true)
	})

	it("stays due for the rest of the local day so a missed tick still sends", () => {
		const utc = { dayOfWeek: MONDAY, sendHour: 9, timezone: "UTC" }
		expect(isDigestDue(utc, null, at("2026-07-06T23:45:00Z"))).toBe(true)
		expect(isDigestDue(utc, null, at("2026-07-07T00:00:00Z"))).toBe(false)
	})

	it("sends once per week however many ticks fall in the window", () => {
		const utc = { dayOfWeek: MONDAY, sendHour: 9, timezone: "UTC" }
		const sentAt = at("2026-07-06T09:00:00Z")
		expect(isDigestDue(utc, sentAt, at("2026-07-06T09:15:00Z"))).toBe(false)
		expect(isDigestDue(utc, sentAt, sentAt + WEEK_MS)).toBe(true)
	})

	it("does not send twice when the hour or zone moves right after a send", () => {
		const sentAt = at("2026-07-06T07:00:00Z")
		const later = { dayOfWeek: MONDAY, sendHour: 15, timezone: "Europe/Berlin" }
		expect(isDigestDue(later, sentAt, at("2026-07-06T13:00:00Z"))).toBe(false)
	})

	it("follows the local clock across the spring DST change", () => {
		const berlin = { dayOfWeek: MONDAY, sendHour: 9, timezone: "Europe/Berlin" }
		// Sent Monday 23 March at 09:00 CET (08:00 UTC); clocks go forward on Sunday 29 March.
		const sentAt = at("2026-03-23T08:00:00Z")
		expect(isDigestDue(berlin, sentAt, at("2026-03-30T06:45:00Z"))).toBe(false)
		// 09:00 CEST is 07:00 UTC, less than seven days after the last send.
		expect(isDigestDue(berlin, sentAt, at("2026-03-30T07:00:00Z"))).toBe(true)
	})

	it("does not resend in the repeated hour when clocks fall back", () => {
		const newYork = { dayOfWeek: SUNDAY, sendHour: 1, timezone: "America/New_York" }
		// 01:00 happens twice on Sunday 1 November 2026: 05:00 UTC (EDT) and 06:00 UTC (EST).
		const sentAt = at("2026-11-01T05:00:00Z")
		expect(isDigestDue(newYork, null, sentAt)).toBe(true)
		expect(isDigestDue(newYork, sentAt, at("2026-11-01T06:00:00Z"))).toBe(false)
	})

	it("falls back to UTC for a zone the runtime does not know", () => {
		const unknown = { dayOfWeek: MONDAY, sendHour: 9, timezone: "Mars/Olympus_Mons" }
		expect(isDigestDue(unknown, null, at("2026-07-06T08:59:00Z"))).toBe(false)
		expect(isDigestDue(unknown, null, at("2026-07-06T09:00:00Z"))).toBe(true)
	})

	it("counts an attempt whose send was never recorded, across UTC midnight", () => {
		const losAngeles = { dayOfWeek: MONDAY, sendHour: 15, timezone: "America/Los_Angeles" }
		const attemptedAt = at("2026-07-06T22:00:00Z")
		const afterUtcMidnight = at("2026-07-07T00:15:00Z")
		expect(isDigestDue(losAngeles, null, afterUtcMidnight)).toBe(true)
		expect(isDigestDue(losAngeles, lastDigestActivity(null, attemptedAt), afterUtcMidnight)).toBe(false)
		expect(lastDigestActivity(attemptedAt - 1000, attemptedAt)).toBe(attemptedAt)
	})
})
