import { describe, expect, it } from "vitest"

import {
	EMPTY_MEASURES,
	aggregateByBucket,
	OTHER_SERIES_KEY,
	TOOL_SERIES_COLOR_TOKENS,
	errorRate,
	foldSeries,
	formatDurationNs,
	formatToolMetric,
	metricDelta,
	metricRiseIsBad,
	metricSpark,
	metricValue,
	rankSeriesKeys,
	scopeSummary,
	toolChartTitle,
	toolMetricLabel,
	toolSeriesColors,
	toolSeriesMode,
	type ToolSeriesPoint,
} from "./tool-analytics"

const measures = (over: Partial<typeof EMPTY_MEASURES> = {}) => ({ ...EMPTY_MEASURES, ...over })

const point = (
	bucket: number,
	seriesKey: string,
	over: Partial<typeof EMPTY_MEASURES> = {},
): ToolSeriesPoint => ({ bucket, seriesKey, ...measures(over) })

describe("toolSeriesMode", () => {
	it("splits by tool until a tool is picked, then by model, then not at all", () => {
		expect(toolSeriesMode(undefined, undefined)).toBe("tools")
		expect(toolSeriesMode("run_tests", undefined)).toBe("models")
		expect(toolSeriesMode("run_tests", "claude-opus-5")).toBe("single")
	})

	it("splits by tool when only a model is picked — the question is still which tool", () => {
		expect(toolSeriesMode(undefined, "claude-opus-5")).toBe("tools")
	})
})

describe("metricValue", () => {
	const row = measures({ calls: 200, sessions: 12, errors: 10, p50: 1e9, p90: 4e9, p95: 9e9 })

	it("reads the counts straight off the row", () => {
		expect(metricValue(row, "calls", "p90")).toBe(200)
		expect(metricValue(row, "sessions", "p90")).toBe(12)
	})

	it("derives the error rate rather than reading a stored one", () => {
		expect(metricValue(row, "error_rate", "p90")).toBeCloseTo(0.05)
	})

	it("has no rate for a row that never ran", () => {
		expect(metricValue(measures({ errors: 0 }), "error_rate", "p90")).toBe(0)
		expect(errorRate({ calls: 0, errors: 0 })).toBe(0)
	})

	it("follows the selected percentile for duration", () => {
		expect(metricValue(row, "duration", "p50")).toBe(1e9)
		expect(metricValue(row, "duration", "p95")).toBe(9e9)
	})
})

describe("formatting", () => {
	it("converts nanoseconds before formatting a latency", () => {
		expect(formatDurationNs(1_500_000)).toBe("1.5ms")
		expect(formatDurationNs(2_000_000_000)).toBe("2.00s")
	})

	it("prints an em dash for a duration that was never measured", () => {
		expect(formatDurationNs(0)).toBe("—")
		expect(formatDurationNs(Number.NaN)).toBe("—")
	})

	it("formats each metric in its own units", () => {
		expect(formatToolMetric(1200, "calls")).toBe("1.2K")
		expect(formatToolMetric(0.05, "error_rate")).toBe("5.0%")
		expect(formatToolMetric(2_000_000_000, "duration")).toBe("2.00s")
	})

	it("names the percentile only where one is driving the number", () => {
		expect(toolMetricLabel("calls", "p90")).toBe("Tool calls")
		expect(toolMetricLabel("duration", "p95")).toBe("P95 duration")
	})
})

describe("metricDelta", () => {
	it("is the fractional change against the previous window", () => {
		expect(metricDelta(measures({ calls: 150 }), measures({ calls: 100 }), "calls", "p90")).toBeCloseTo(0.5)
		expect(metricDelta(measures({ calls: 50 }), measures({ calls: 100 }), "calls", "p90")).toBeCloseTo(-0.5)
	})

	it("has nothing to report without a previous window", () => {
		expect(metricDelta(measures({ calls: 150 }), undefined, "calls", "p90")).toBeNull()
	})

	it("refuses to divide by a previous window of zero", () => {
		expect(metricDelta(measures({ calls: 150 }), measures({ calls: 0 }), "calls", "p90")).toBeNull()
	})

	it("knows which way is bad", () => {
		expect(metricRiseIsBad("error_rate")).toBe(true)
		expect(metricRiseIsBad("duration")).toBe(true)
		expect(metricRiseIsBad("calls")).toBe(false)
	})
})

describe("rankSeriesKeys", () => {
	it("ranks by total calls, not by the selected metric", () => {
		const points = [
			point(1, "read", { calls: 10, errors: 0, p90: 1 }),
			point(1, "bash", { calls: 100, errors: 1, p90: 1e9 }),
			point(2, "read", { calls: 5 }),
		]
		expect(rankSeriesKeys(points)).toEqual(["bash", "read"])
	})

	it("breaks ties by name so the order never wobbles between renders", () => {
		const points = [point(1, "beta", { calls: 5 }), point(1, "alpha", { calls: 5 })]
		expect(rankSeriesKeys(points)).toEqual(["alpha", "beta"])
	})
})

describe("foldSeries", () => {
	const points = [
		point(1, "a", { calls: 100, sessions: 10, errors: 5, p90: 1e9 }),
		point(1, "b", { calls: 80 }),
		point(1, "c", { calls: 60 }),
		point(1, "d", { calls: 40 }),
		point(1, "e", { calls: 30, sessions: 3, errors: 3, p90: 2e9 }),
		point(1, "f", { calls: 10, sessions: 1, errors: 0, p90: 12e9 }),
		point(2, "f", { calls: 4, p90: 5e9 }),
	]

	it("leaves a short list alone", () => {
		const short = [point(1, "a", { calls: 2 }), point(1, "b", { calls: 1 })]
		expect(foldSeries(short, 4)).toEqual({ points: short, keys: ["a", "b"] })
	})

	it("keeps the top N and folds the rest into one Other line", () => {
		const folded = foldSeries(points, 4)
		expect(folded.keys).toEqual(["a", "b", "c", "d", OTHER_SERIES_KEY])
		expect(folded.points.some((p) => p.seriesKey === "e")).toBe(false)
	})

	it("adds the tail's counts", () => {
		const folded = foldSeries(points, 4)
		const other = folded.points.find((p) => p.seriesKey === OTHER_SERIES_KEY && p.bucket === 1)!
		expect(other.calls).toBe(40)
		expect(other.sessions).toBe(4)
		expect(other.errors).toBe(3)
	})

	it("weights the tail's percentiles by calls rather than averaging them flat", () => {
		const folded = foldSeries(points, 4)
		const other = folded.points.find((p) => p.seriesKey === OTHER_SERIES_KEY && p.bucket === 1)!
		// (2e9 * 30 + 12e9 * 10) / 40 — a flat mean would be 7e9.
		expect(other.p90).toBeCloseTo(4.5e9)
	})

	it("folds each bucket independently", () => {
		const folded = foldSeries(points, 4)
		const second = folded.points.find((p) => p.seriesKey === OTHER_SERIES_KEY && p.bucket === 2)!
		expect(second.calls).toBe(4)
		expect(second.p90).toBeCloseTo(5e9)
	})

	it("merges the API's own folded tail into this one, as a single line", () => {
		// The API folds past its own top-N before the page ever sees a point, so
		// `Other` can arrive as a key. Ranked as a series it would draw a second
		// grey line and a second legend entry for the same residue.
		const withApiTail = [
			point(1, "a", { calls: 100 }),
			point(1, "b", { calls: 80 }),
			point(1, OTHER_SERIES_KEY, { calls: 90, errors: 2 }),
			point(1, "c", { calls: 5 }),
		]
		const folded = foldSeries(withApiTail, 2)
		expect(folded.keys).toEqual(["a", "b", OTHER_SERIES_KEY])
		const other = folded.points.filter((p) => p.seriesKey === OTHER_SERIES_KEY)
		expect(other).toHaveLength(1)
		expect(other[0]!.calls).toBe(95)
		expect(other[0]!.errors).toBe(2)
	})

	it("folds an API tail even when nothing else needs folding", () => {
		const short = [point(1, "a", { calls: 3 }), point(1, OTHER_SERIES_KEY, { calls: 1 })]
		expect(foldSeries(short, 4).keys).toEqual(["a", OTHER_SERIES_KEY])
	})

	it("leaves a tail with no calls at a zero percentile rather than dividing by zero", () => {
		const zeroTail = [
			point(1, "a", { calls: 5 }),
			point(1, "b", { calls: 4 }),
			point(1, "c", { calls: 0, p90: 9e9 }),
		]
		const other = foldSeries(zeroTail, 2).points.find((p) => p.seriesKey === OTHER_SERIES_KEY)!
		expect(other.p90).toBe(0)
	})
})

describe("toolSeriesColors", () => {
	it("assigns the palette in rank order, starting past the primary", () => {
		const colors = toolSeriesColors(["a", "b", "c"])
		expect(colors.get("a")).toBe(TOOL_SERIES_COLOR_TOKENS[0])
		expect(colors.get("b")).toBe(TOOL_SERIES_COLOR_TOKENS[1])
		expect(colors.get("c")).toBe(TOOL_SERIES_COLOR_TOKENS[2])
	})

	it("never hands a series the selection colour", () => {
		const colors = toolSeriesColors(["a", "b", "c", "d", "e", "f"])
		expect([...colors.values()]).not.toContain("--chart-1")
	})

	it("paints Other grey wherever it lands, without consuming a palette slot", () => {
		const colors = toolSeriesColors(["a", OTHER_SERIES_KEY, "b"])
		expect(colors.get(OTHER_SERIES_KEY)).toBe("--muted-foreground")
		expect(colors.get("b")).toBe(TOOL_SERIES_COLOR_TOKENS[1])
	})
})

describe("toolChartTitle", () => {
	it("reads measure · scope · split", () => {
		expect(toolChartTitle({ metric: "error_rate", percentile: "p90", tool: "run_tests" })).toBe(
			"Error rate · run_tests · by model",
		)
	})

	it("splits by tool while nothing is picked", () => {
		expect(toolChartTitle({ metric: "calls", percentile: "p90" })).toBe("Tool calls · by tool")
	})

	it("drops the split once one line is left", () => {
		expect(
			toolChartTitle({ metric: "duration", percentile: "p95", tool: "grep", model: "claude-opus-5" }),
		).toBe("P95 duration · grep · claude-opus-5")
	})
})

describe("scopeSummary", () => {
	it("says how much of the window the selection accounts for", () => {
		expect(scopeSummary(measures({ calls: 120, sessions: 8 }), 4000)).toBe(
			"120 of 4.0K calls match · 8 sessions",
		)
	})

	it("drops the denominator when nothing is narrowing it", () => {
		expect(scopeSummary(measures({ calls: 4000, sessions: 8 }), 4000)).toBe("4.0K calls · 8 sessions")
	})

	it("counts one session in the singular", () => {
		expect(scopeSummary(measures({ calls: 3, sessions: 1 }), 3)).toBe("3 calls · 1 session")
	})
})

describe("aggregateByBucket", () => {
	const points = [
		point(2, "a", { calls: 10, sessions: 2, errors: 1, p90: 1e9 }),
		point(1, "a", { calls: 30, sessions: 3, errors: 0, p90: 2e9 }),
		point(1, "b", { calls: 10, sessions: 1, errors: 5, p90: 6e9 }),
	]

	it("returns one row per bucket, in bucket order", () => {
		expect(aggregateByBucket(points).map((row) => row.bucket)).toEqual([1, 2])
	})

	it("adds the counts across series", () => {
		const [first] = aggregateByBucket(points)
		expect(first!.calls).toBe(40)
		expect(first!.errors).toBe(5)
	})

	it("weights percentiles by calls", () => {
		const [first] = aggregateByBucket(points)
		// (2e9 * 30 + 6e9 * 10) / 40
		expect(first!.p90).toBeCloseTo(3e9)
	})
})

describe("metricSpark", () => {
	it("reads the selected metric off each bucket", () => {
		const points = [
			point(1, "a", { calls: 20, errors: 2 }),
			point(2, "a", { calls: 10, errors: 5 }),
		]
		expect(metricSpark(points, "calls", "p90")).toEqual([20, 10])
		expect(metricSpark(points, "error_rate", "p90")).toEqual([0.1, 0.5])
	})
})
