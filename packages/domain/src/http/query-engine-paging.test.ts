import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ListHostsRequest } from "./query-engine"

const decode = Schema.decodeUnknownExit(ListHostsRequest)
const window = { startTime: "2026-11-03 10:00:00", endTime: "2026-11-03 11:00:00" }

describe("list request paging", () => {
	it("accepts a whole, non-negative offset", () => {
		expect(decode({ ...window, offset: 0 })._tag).toBe("Success")
		expect(decode({ ...window, offset: 50 })._tag).toBe("Success")
	})

	it("rejects an offset the query builder would refuse at compile time", () => {
		expect(decode({ ...window, offset: -1 })._tag).toBe("Failure")
		expect(decode({ ...window, offset: 1.5 })._tag).toBe("Failure")
	})
})
