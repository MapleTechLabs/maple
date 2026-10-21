import { describe, expect, it } from "vitest"
import { pollReportDue } from "./integration-sources"

const now = 10 * 60_000
const recorded = { lastPollAt: now - 30_000, lastPollError: null, disconnectedAt: null }

describe("pollReportDue", () => {
	it("skips a tick that changes nothing within a minute of the last record", () => {
		expect(pollReportDue(recorded, { _tag: "Ok" }, now)).toBe(false)
		expect(pollReportDue({ ...recorded, lastPollAt: now - 90_000 }, { _tag: "Ok" }, now)).toBe(true)
	})

	it("writes as soon as the outcome moves", () => {
		expect(pollReportDue(recorded, { _tag: "Failed", error: "HTTP 503" }, now)).toBe(true)
		expect(
			pollReportDue({ ...recorded, lastPollError: "HTTP 503" }, { _tag: "Failed", error: "HTTP 503" }, now),
		).toBe(false)
		expect(pollReportDue({ ...recorded, lastPollError: "HTTP 503" }, { _tag: "Ok" }, now)).toBe(true)
		expect(pollReportDue(recorded, { _tag: "Disconnected", reason: "Revoked" }, now)).toBe(true)
		expect(pollReportDue({ ...recorded, disconnectedAt: now - 60_000 }, { _tag: "Ok" }, now)).toBe(true)
	})
})
