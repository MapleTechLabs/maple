import { describe, expect, it } from "vitest"

import { legendPlacementFor } from "../timeseries"

describe("legendPlacementFor", () => {
	it("maps the right-hand mode to the frame's right placement", () => {
		// The bug this closes: every timeseries chart passed its legend and left
		// `legendPlacement` at "bottom", so `legend="right"` rendered a vertical
		// column — one series per row, height-capped to the container — and then
		// stacked it UNDER the plot, which is what "right" was added to prevent.
		expect(legendPlacementFor("right")).toBe("right")
	})

	it("leaves every other mode at the bottom", () => {
		expect(legendPlacementFor("visible")).toBe("bottom")
		expect(legendPlacementFor("hidden")).toBe("bottom")
		expect(legendPlacementFor(undefined)).toBe("bottom")
	})
})
