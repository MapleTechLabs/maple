import { describe, expect, it } from "vitest"
import { indexedTabState } from "./view-detail"

describe("indexedTabState", () => {
	it("tells a warehouse without the per-user rollup apart from a user with no rows", () => {
		expect(indexedTabState(null, [])).toBe("unindexed")
		expect(indexedTabState(0, [])).toBe("empty")
		expect(indexedTabState(3, [{}])).toBe("rows")
	})
})
