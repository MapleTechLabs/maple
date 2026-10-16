import { describe, expect, it } from "vitest"
import { describeNotice, formatAsOf } from "./stale-data-notice"

const now = new Date(2026, 9, 15, 20, 30).getTime()
const at = new Date(2026, 9, 15, 20, 14).getTime()
const base = {
	disconnected: false,
	busy: false,
	refreshFailed: false,
	shownAsOfMs: at,
	staleAsOfMs: null,
	nowMs: now,
}

describe("describeNotice", () => {
	it("stays hidden while everything on screen is current", () => {
		expect(describeNotice({ ...base, busy: true })).toBeNull()
	})

	it("names the reason the shown results are old", () => {
		const time = formatAsOf(at, now)
		expect(describeNotice({ ...base, disconnected: true })?.text).toBe(
			`Can’t reach Maple Local. Showing results from ${time}.`,
		)
		expect(describeNotice({ ...base, staleAsOfMs: at, busy: true })?.text).toBe(
			`Maple Local is busy. Showing results from ${time}.`,
		)
		expect(describeNotice({ ...base, staleAsOfMs: at, refreshFailed: true, busy: true })).toMatchObject({
			text: `Couldn’t refresh. Showing results from ${time}.`,
			retry: true,
		})
		expect(describeNotice({ ...base, staleAsOfMs: at })?.text).toBe(
			`Loading newer results. Showing results from ${time}.`,
		)
	})

	it("adds the day once the results are from before today", () => {
		const yesterday = new Date(2026, 9, 14, 20, 14).getTime()
		expect(formatAsOf(yesterday, now)).not.toBe(formatAsOf(at, now))
		expect(formatAsOf(yesterday, now)).toContain("14")
	})
})
