import { assert, describe, it } from "vitest"
import { fanoutTimeRefusal } from "./review-fanout"

describe("fanoutTimeRefusal", () => {
	it("starts a group with time for the child and the parent's submit", () => {
		assert.isUndefined(fanoutTimeRefusal(10 * 60_000))
		assert.isUndefined(fanoutTimeRefusal(5.5 * 60_000))
	})

	// The engine does not stop a child at the parent's deadline: a late start loses its findings.
	it("refuses a group that could not finish before the review is stopped", () => {
		const late = fanoutTimeRefusal(5 * 60_000)
		assert.include(late ?? "", "300 s are left")
		assert.include(late ?? "", "pr_file_diff")
		assert.include(fanoutTimeRefusal(-1_000) ?? "", "0 s are left")
	})
})
