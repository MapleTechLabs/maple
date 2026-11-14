import { describe, expect, it } from "vitest"
import { USER_DETAIL } from "../../lab/users-fixture"
import { indexedTabState, tabCount } from "./view-detail"

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
