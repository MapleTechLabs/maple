import { describe, expect, it } from "vitest"

import {
	EMPTY_OVERVIEW_MEASURES,
	buildModelMix,
	buildOverviewSeries,
	type OverviewMeasurePoint,
	type OverviewMeasures,
	type OverviewModelMix,
} from "./overview-analytics"
import {
	OVERVIEW_TICK_PADDING,
	buildOverviewPlotSpec,
	overviewAxisGutter,
	overviewAxisTick,
	type OverviewPlotInput,
	type OverviewPlotSpec,
} from "./overview-chart-specs"

const HOUR = 3_600_000
const START = Date.UTC(2026, 8, 10, 0, 0, 0)

const point = (index: number, overrides: Partial<OverviewMeasures>): OverviewMeasurePoint => ({
	...EMPTY_OVERVIEW_MEASURES,
	...overrides,
	bucket: START + index * HOUR,
})

const EMPTY_MIX: OverviewModelMix = { models: [], points: [] }

const input = (overrides: Partial<OverviewPlotInput>): OverviewPlotInput => ({
	series: [],
	previousSeries: [],
	modelMix: EMPTY_MIX,
	...overrides,
})

const series = buildOverviewSeries([
	point(0, { sessions: 10, cost: 5, tokens: 300, inputTokens: 200, cacheReadTokens: 100 }),
	point(1, { sessions: 20, cost: 30, tokens: 900, inputTokens: 600, outputTokens: 300 }),
])

describe("buildOverviewPlotSpec", () => {
	it("draws the previous period only when there is one to draw", () => {
		const without = buildOverviewPlotSpec("sessions", input({ series }))
		expect(without.marks.map((mark) => mark.kind)).toEqual(["line"])

		// Already shifted onto this axis, which is what the ghost is matched by.
		const withGhost = buildOverviewPlotSpec("sessions", input({ series, previousSeries: series }))
		expect(withGhost.marks.map((mark) => mark.kind)).toEqual(["line", "ghost"])
		expect(withGhost.legend.at(-1)?.label).toBe("prev")
	})

	it("names no ghost when the previous points landed off this axis", () => {
		// A previous series a bucket out has nothing to draw at any x the plot
		// has, and a legend entry for it would promise a line that is not there.
		const offAxis = buildOverviewSeries([point(-1, { sessions: 8 }), point(-2, { sessions: 6 })])
		const spec = buildOverviewPlotSpec("sessions", input({ series, previousSeries: offAxis }))
		expect(spec.marks.map((mark) => mark.kind)).toEqual(["line"])
	})

	it("tops the axis on the rung ABOVE the data, and at 1 for an empty window", () => {
		// 20 sessions is itself a rung on the ladder, so the axis takes the next
		// one: a flat line drawn along the top edge reads as clipped, not steady.
		expect(buildOverviewPlotSpec("sessions", input({ series })).yMax).toBe(25)
		expect(buildOverviewPlotSpec("toolCallsPerSession", input({ series })).yMax).toBe(1)
		expect(buildOverviewPlotSpec("sessions", input({})).yMax).toBe(1)
	})

	it("pins the share charts to a full axis so a mix is read against 100%", () => {
		expect(buildOverviewPlotSpec("cacheHitRatio", input({ series })).yMax).toBe(1)
		expect(buildOverviewPlotSpec("modelMix", input({})).yMax).toBe(1)
	})

	it("stacks the token bands, each layer sitting on the one below", () => {
		const spec = buildOverviewPlotSpec("tokensPerSession", input({ series }))
		expect(spec.marks.map((mark) => mark.key)).toEqual([
			"input",
			"cacheRead",
			"cacheWrite",
			"output",
			"reasoning",
		])
		// 200 input + 100 cache read over 10 sessions: 20 then 30.
		expect(spec.rows[0]?.input).toBe(20)
		expect(spec.rows[0]?.cacheRead_base).toBe(20)
		expect(spec.rows[0]?.cacheRead).toBe(30)
		expect(spec.yMax).toBe(50)
	})

	it("falls back to one band when no bucket reported a breakdown", () => {
		const flat = buildOverviewSeries([point(0, { sessions: 4, tokens: 400 })])
		const spec = buildOverviewPlotSpec("tokensPerSession", input({ series: flat }))
		expect(spec.marks.map((mark) => mark.key)).toEqual(["total"])
		expect(spec.rows[0]?.total).toBe(100)
	})

	it("names the leading models in the legend and counts the rest", () => {
		const mix = buildModelMix(
			["a", "b", "c", "d"].map((model, index) => ({
				bucket: START,
				model,
				llmCallSpans: 10 - index,
			})),
		)
		const spec = buildOverviewPlotSpec("modelMix", input({ modelMix: mix }))
		expect(spec.marks).toHaveLength(4)
		expect(spec.legend).toHaveLength(3)
		expect(spec.legendMore).toBe(1)
		expect(spec.legend[0]?.label).toBe("a 29%")
	})

	it("spreads the duration band from p50 up to p95", () => {
		const durations = buildOverviewSeries([
			point(0, { sessions: 1, sessionDurationP50Ms: 1_000, sessionDurationP95Ms: 4_000 }),
		])
		const spec = buildOverviewPlotSpec("sessionDuration", input({ series: durations }))
		expect(spec.marks.map((mark) => mark.kind)).toEqual(["spread", "line"])
		expect(spec.rows[0]?.p95_base).toBe(1_000)
		expect(spec.rows[0]?.p95).toBe(4_000)
	})
})

describe("overviewAxisGutter", () => {
	const axis = (yMax: number, format: (value: number) => string): OverviewPlotSpec =>
		({ yMax, format }) as OverviewPlotSpec

	it("prints the floor as a digit and the top through the chart's formatter", () => {
		const spec = axis(0.5, (value) => `$${value.toFixed(2)}`)
		expect(overviewAxisTick(spec, 0)).toBe("0")
		expect(overviewAxisTick(spec, spec.yMax)).toBe("$0.50")
	})

	it("holds the design's width for the labels it was drawn around", () => {
		expect(overviewAxisGutter([axis(1, () => "100%"), axis(8, () => "8.0")])).toBe(32)
	})

	it("widens to the widest label in the grid, and gives every plot the same one", () => {
		const narrow = axis(1, () => "100%")
		const wide = axis(150_000, () => "150.0K")
		expect(overviewAxisGutter([narrow])).toBe(32)
		expect(overviewAxisGutter([narrow, wide])).toBe(overviewAxisGutter([wide]))
		expect(overviewAxisGutter([narrow, wide])).toBeGreaterThan(overviewAxisGutter([narrow]))
	})

	it("leaves every label room to sit right-aligned off the plot", () => {
		// 6.02px per character at the 10px mono tick size, plus the tick padding.
		for (const label of ["$0.50", "80.0K", "10.0%", "2m 30s", "100%"]) {
			const gutter = overviewAxisGutter([axis(1, () => label)])
			expect(gutter - OVERVIEW_TICK_PADDING).toBeGreaterThanOrEqual(label.length * 6.02)
		}
	})
})
