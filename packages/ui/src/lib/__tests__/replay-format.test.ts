import { describe, expect, it } from "vitest"

import { formatSessionDuration, isSessionLive, sessionDurationMs } from "../replay-format"

describe("formatSessionDuration", () => {
	it("renders missing, zero, and negative durations as an em dash", () => {
		expect(formatSessionDuration(null)).toBe("—")
		expect(formatSessionDuration(0)).toBe("—")
		expect(formatSessionDuration(-60_000)).toBe("—")
	})

	it("renders sub-hour durations in minutes and seconds", () => {
		expect(formatSessionDuration(45_000)).toBe("45s")
		expect(formatSessionDuration(90_000)).toBe("1m 30s")
		expect(formatSessionDuration(3_599_499)).toBe("59m 59s")
	})

	it("rolls minutes into hours", () => {
		expect(formatSessionDuration(3_600_000)).toBe("1h 0m")
		expect(formatSessionDuration(5_400_000)).toBe("1h 30m")
		expect(formatSessionDuration(28_812_000)).toBe("8h 0m")
	})
})

// A session's `Status` reaches `"ended"` only if its tab lived long enough to
// run an unload handler. Killed tabs, crashes and slept phones never do, so the
// row keeps saying `"active"` for the rest of its 30-day retention. In Maple's
// own org that was 70 sessions in a day wearing a LIVE badge, of which one was
// actually live. Recency is the half that makes the answer true.

const NOW = Date.parse("2026-09-09T12:00:00Z")
const at = (isoMinutesAgo: number) => new Date(NOW - isoMinutesAgo * 60_000).toISOString()

describe("isSessionLive", () => {
	it("is live while the heartbeat is inside the window", () => {
		expect(
			isSessionLive({ status: "active", lastActivityAt: at(2), startTime: at(40) }, NOW),
		).toBe(true)
	})

	it("is not live once the heartbeat has gone quiet", () => {
		expect(
			isSessionLive({ status: "active", lastActivityAt: at(31), startTime: at(40) }, NOW),
		).toBe(false)
	})

	it("is never live for a session that reported its own end", () => {
		expect(isSessionLive({ status: "ended", lastActivityAt: at(1), startTime: at(5) }, NOW)).toBe(
			false,
		)
	})

	it("falls back to the start time when no heartbeat has landed yet", () => {
		// The v1 start row carries no LastActivityAt. A session seconds old is
		// genuinely live; the stranded start row of a tab that went away is not,
		// and the window separates them without a special case.
		expect(isSessionLive({ status: "active", lastActivityAt: null, startTime: at(1) }, NOW)).toBe(
			true,
		)
		expect(isSessionLive({ status: "active", lastActivityAt: null, startTime: at(90) }, NOW)).toBe(
			false,
		)
	})

	it("accepts warehouse-shaped timestamps, not just ISO", () => {
		expect(
			isSessionLive(
				{ status: "active", lastActivityAt: "2026-09-09 11:58:00", startTime: "2026-09-09 11:00:00" },
				NOW,
			),
		).toBe(true)
	})
})

describe("sessionDurationMs", () => {
	it("prefers the stored duration once the end row lands", () => {
		expect(
			sessionDurationMs({
				status: "ended",
				lastActivityAt: at(1),
				startTime: at(10),
				durationMs: 42_000,
			}),
		).toBe(42_000)
	})

	it("recovers a duration from the heartbeat when there is no end row", () => {
		expect(
			sessionDurationMs({
				status: "active",
				lastActivityAt: at(10),
				startTime: at(25),
				durationMs: null,
			}),
		).toBe(15 * 60_000)
	})

	it("stays unmeasured when nothing but the start row exists", () => {
		expect(
			sessionDurationMs({ status: "active", lastActivityAt: null, startTime: at(5), durationMs: null }),
		).toBeNull()
	})
})
