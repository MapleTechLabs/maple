import { describe, expect, it } from "vitest"
import { buildListLogsParams } from "./list-logs-params"

describe("buildListLogsParams body search", () => {
	it("searches the message text with body, message or search", () => {
		for (const key of ["body", "message", "search"]) {
			expect(buildListLogsParams(`${key} contains "timeout"`, 50)).toEqual({
				params: { limit: 50, search: "timeout" },
				warnings: [],
			})
		}
	})

	it("keeps the first body clause and warns about the second", () => {
		expect(buildListLogsParams('body contains "timeout" AND message contains "retry"', 50)).toEqual({
			params: { limit: 50, search: "timeout" },
			warnings: ["Only one body filter supported; ignoring message contains retry"],
		})
	})
})
