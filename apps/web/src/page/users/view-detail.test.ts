import { describe, expect, it } from "vitest"
import { USER_DETAIL } from "../../lab/users-fixture"
import { dayLabel, indexedTabState, tabCount } from "./view-detail"

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

describe("tabCount", () => {
	it("counts the Traces tab by its rows, the user's requests, not their distinct traces", () => {
		const detail = { ...USER_DETAIL, profile: { ...USER_DETAIL.profile, requests: 57, traces: 12 } }
		expect(tabCount("traces", detail)).toBe(57)
	})
})

describe("tabCount while the activity read is out", () => {
	it("leaves the MCP count off rather than reading zero", () => {
		expect(tabCount("mcp", { ...USER_DETAIL, mcpSessions: [], activityPending: true })).toBeUndefined()
		expect(tabCount("mcp", { ...USER_DETAIL, mcpSessions: [] })).toBe(0)
	})
})
