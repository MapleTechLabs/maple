import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { decodePlotTimeAxis, encodePlotTimeAxis, timeAtPlotX } from "./plot-time-axis"

const axis = { domainStartMs: 1_000_000, domainEndMs: 1_600_000, startPx: 10, endPx: 310 }

describe("plot time axis", () => {
	test("what the chart writes on its anchor reads back as the same scale", () => {
		expect(decodePlotTimeAxis(encodePlotTimeAxis(axis))).toEqual(Option.some(axis))
	})

	test("a missing, garbled or spanless attribute is no axis", () => {
		expect([
			decodePlotTimeAxis(null),
			decodePlotTimeAxis(""),
			decodePlotTimeAxis("1,2,x,4"),
			decodePlotTimeAxis("5,5,0,100"),
			decodePlotTimeAxis("1,2,40,40"),
		]).toEqual([Option.none(), Option.none(), Option.none(), Option.none(), Option.none()])
	})

	test("a pixel maps to its time, and a pixel off the scale stops at the domain's edge", () => {
		expect([
			timeAtPlotX(axis, 10),
			timeAtPlotX(axis, 160),
			timeAtPlotX(axis, 310),
			timeAtPlotX(axis, -50),
			timeAtPlotX(axis, 900),
		]).toEqual([1_000_000, 1_300_000, 1_600_000, 1_000_000, 1_600_000])
	})
})
