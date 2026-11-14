import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { fmtSpan } from "./funnel-dropoff-steps"

describe("fmtSpan", () => {
	it("keeps the seconds under ten minutes, then rounds to the coarser unit", () => {
		const seconds = [45, 101, 146, 420, 599, 2_700, 6_720, 187_200]
		expect(Arr.map(seconds, (value) => fmtSpan(value * 1000))).toEqual([
			"45s",
			"1m 41s",
			"2m 26s",
			"7m",
			"9m 59s",
			"45m",
			"1h 52m",
			"2d 4h",
		])
	})
})
