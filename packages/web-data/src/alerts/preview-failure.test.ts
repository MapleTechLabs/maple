import { describe, expect, it } from "vitest"

import { mapBuilderChartFailure, NO_QUERY_DATA_MESSAGE } from "./preview-failure"

describe("mapBuilderChartFailure", () => {
	it("treats the no-data failure as a healthy empty chart", () => {
		expect(mapBuilderChartFailure(NO_QUERY_DATA_MESSAGE)).toBeNull()
	})

	it("surfaces every other failure message as a chart error", () => {
		expect(mapBuilderChartFailure("Unsupported traces metric: p42")).toBe(
			"Unsupported traces metric: p42",
		)
	})
})
