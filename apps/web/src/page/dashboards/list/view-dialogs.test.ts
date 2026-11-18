import { describe, expect, it } from "vitest"
import { importReportSummary } from "./view-dialogs"

describe("importReportSummary", () => {
	it("says a panel-less dashboard has nothing to convert, not 0 of 0", () => {
		expect(importReportSummary({ panels: 0, converted: 0 })).toBe(
			"The dashboard has no panels to convert.",
		)
	})

	it("counts converted panels and the notes the rest became", () => {
		expect(importReportSummary({ panels: 5, converted: 4 })).toBe(
			"4 of 5 panels converted. 1 panel Maple cannot run yet became a note that keeps its original queries.",
		)
	})
})
