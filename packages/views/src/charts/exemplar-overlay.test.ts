import { Option } from "effect"
import { describe, expect, it } from "vitest"
import type { PlotGeometry } from "./chart"
import { dotPosition, type ExemplarDot, standsOut } from "./exemplar-overlay"

// A 200 px tall plot whose y runs 0 (bottom, 200 px) to 2 (top, 0 px): 100 px per unit.
const plot: PlotGeometry = {
	x: 0,
	y: 0,
	width: 600,
	height: 200,
	domainStartMs: 0,
	domainEndMs: 60_000,
	rangeStart: 0,
	rangeEnd: 600,
	valueStart: 0,
	valueEnd: 2,
	valueRangeStart: 200,
	valueRangeEnd: 0,
}

const dot = (value: number, baseline: number | undefined): ExemplarDot => ({
	key: "k",
	atMs: 30_000,
	value,
	baseline,
	title: "",
	rows: [],
})

const standing = (value: number, baseline: number | undefined) =>
	Option.match(dotPosition(plot, 30_000, value), {
		onNone: () => null,
		onSome: ({ top }) => standsOut(plot, dot(value, baseline), top),
	})

describe("exemplar dots at rest", () => {
	it("show when they sit clearly above the line, and wait for the cursor when they sit on it", () => {
		// 0.5 above the line is 50 px: clear of it.
		expect(standing(1.5, 1)).toBe(true)
		// 0.05 above is 5 px: on the line.
		expect(standing(1.05, 1)).toBe(false)
		// Below the line reads as on it too.
		expect(standing(0.8, 1)).toBe(false)
	})

	it("show when there is no line value to compare with", () => {
		expect(standing(1.05, undefined)).toBe(true)
	})
})
