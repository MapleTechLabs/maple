import { describe, expect, it } from "vitest"
import { formatShare } from "./uptime-derive"

describe("formatShare", () => {
	it("drops the decimals for every whole share, despite floating point", () => {
		expect([11 / 20, 7 / 100, 1, 0].map(formatShare)).toEqual(["55%", "7%", "100%", "0%"])
	})

	it("keeps two decimals otherwise, and a dash with no checks", () => {
		expect([0.9958, 2 / 3, null].map(formatShare)).toEqual(["99.58%", "66.67%", "–"])
	})
})
