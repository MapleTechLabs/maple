import { describe, expect, it } from "vitest"

import {
	EMPTY_MEASURES,
	OTHER_SERIES_KEY,
	TOOL_SERIES_COLOR_TOKENS,
	errorRate,
	formatDurationNs,
	formatToolMetric,
	metricSpark,
	metricValue,
	rankSeriesKeys,
	scopeSummary,
	toolBadges,
	toolChartTitle,
	toolDelta,
	toolMetricLabel,
	toolsTableFooter,
	toolSeriesColors,
	toolSeriesMode,
	type ToolBreakdownRow,
	type ToolSeriesPoint,
} from "./tool-analytics"
import { AI_TOOLS_BREAKDOWN_MAX } from "@maple/domain/http"

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
		expect(formatToolMetric(1200, "calls")).toBe("1,200")
		expect(formatToolMetric(0.05, "error_rate")).toBe("5.0%")
		expect(formatToolMetric(2_000_000_000, "duration")).toBe("2.00s")
	})

	it("names the percentile only where one is driving the number", () => {
		expect(toolMetricLabel("calls", "p90")).toBe("Tool calls")
		expect(toolMetricLabel("duration", "p95")).toBe("P95 duration")
	})
})

describe("toolDelta", () => {
	it("gives a count a percentage", () => {
		expect(toolDelta(measures({ calls: 150 }), measures({ calls: 100 }), "calls", "p90")).toEqual({
			text: "50%",
			direction: "up",
			good: true,
		})
	})

	it("gives a rate POINTS, not a percentage of a percentage", () => {
		// 8% to 16% is "up 8 points". Calling it "up 100%" is a different — and
		// much more alarming — statement about the same two numbers.
		const delta = toolDelta(
			measures({ calls: 100, errors: 16 }),
			measures({ calls: 100, errors: 8 }),
			"error_rate",
			"p90",
		)
		expect(delta).toEqual({ text: "8.0pp", direction: "up", good: false })
	})

	it("gives a latency a duration, and grades a fall as good", () => {
		const delta = toolDelta(
			measures({ p90: 1_000_000_000 }),
			measures({ p90: 3_000_000_000 }),
			"duration",
			"p90",
		)
		expect(delta?.direction).toBe("down")
		expect(delta?.good).toBe(true)
		expect(delta?.text).not.toBe("—")
	})

	it("has no percentage against a window of zero, and none without one at all", () => {
		expect(toolDelta(measures({ calls: 150 }), measures({ calls: 0 }), "calls", "p90")).toBeNull()
		expect(toolDelta(measures({ calls: 150 }), undefined, "calls", "p90")).toBeNull()
	})
})

describe("toolBadges", () => {
	const window = { startMs: 0, endMs: 1000 }
	const row = (over: Partial<ToolBreakdownRow>): ToolBreakdownRow => ({
		key: "k",
		...EMPTY_MEASURES,
		lastSeen: 0,
		firstSeen: 0,
		...over,
	})

	it("calls the slowest only among rows carrying real volume", () => {
		// A tool called nine times in a week has the worst p90 in most windows
		// and is never what the badge is for.
		const badges = toolBadges(
			[
				row({ key: "busy", calls: 1000, p90: 5 }),
				row({ key: "rare", calls: 1, p90: 5000 }),
			],
			window,
		)
		expect(badges.get("busy")).toBe("slowest")
		expect(badges.get("rare")).toBeUndefined()
	})

	it("names no slowest when nothing has a measured p90", () => {
		expect(toolBadges([row({ key: "a", calls: 100, p90: 0 })], window).get("a")).toBeUndefined()
	})

	it("calls a tool new when its first call lands well after the window opened", () => {
		const badges = toolBadges(
			[
				row({ key: "old", calls: 10, firstSeen: 50 }),
				row({ key: "fresh", calls: 10, firstSeen: 900 }),
			],
			window,
		)
		expect(badges.get("fresh")).toBe("new")
		expect(badges.get("old")).toBeUndefined()
	})
})

describe("toolsTableFooter", () => {
	const rows = (count: number): ReadonlyArray<ToolBreakdownRow> =>
		Array.from({ length: count }, (_, index) => ({
			key: `t${index}`,
			...EMPTY_MEASURES,
			calls: 1,
			lastSeen: 0,
			firstSeen: 0,
		}))

	it("says all when the read was not capped", () => {
		expect(toolsTableFooter(rows(3)).subject).toBe("Showing all 3 tools")
		expect(toolsTableFooter(rows(1)).subject).toBe("Showing all 1 tool")
	})

	it("says which rows these are once the read hit its cap", () => {
		// A full page is not "all" — the query returns the busiest N.
		expect(toolsTableFooter(rows(AI_TOOLS_BREAKDOWN_MAX)).subject).toBe(
			`Showing the ${AI_TOOLS_BREAKDOWN_MAX} busiest tools`,
		)
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
	it("reads measure · scope", () => {
		expect(toolChartTitle({ metric: "error_rate", percentile: "p90", tool: "run_tests" })).toBe(
			"Error rate · run_tests",
		)
		expect(toolChartTitle({ metric: "calls", percentile: "p90" })).toBe("Tool calls")
	})

	it("names both scopes once both are picked", () => {
		expect(
			toolChartTitle({ metric: "duration", percentile: "p95", tool: "grep", model: "claude-opus-5" }),
		).toBe("P95 duration · grep · claude-opus-5")
	})
})

describe("scopeSummary", () => {
	it("says how much of the window the selection accounts for", () => {
		expect(scopeSummary(measures({ calls: 120, sessions: 8 }), 4000)).toBe(
			"120 of 4,000 calls match · 8 sessions",
		)
	})

	it("drops the denominator when nothing is narrowing it", () => {
		expect(scopeSummary(measures({ calls: 4000, sessions: 8 }), 4000)).toBe("4,000 calls · 8 sessions")
	})

	it("counts one session in the singular", () => {
		expect(scopeSummary(measures({ calls: 3, sessions: 1 }), 3)).toBe("3 calls · 1 session")
	})
})

describe("metricSpark", () => {
	it("reads the selected metric off each bucket, in bucket order", () => {
		const points = [
			point(2, "a", { calls: 10, errors: 5 }),
			point(1, "a", { calls: 20, errors: 2 }),
		]
		expect(metricSpark(points, "calls", "p90")).toEqual([20, 10])
		expect(metricSpark(points, "error_rate", "p90")).toEqual([0.1, 0.5])
	})
})

describe("toolDelta on an unchanged duration", () => {
	it("prints a flat zero rather than the no-reading dash", () => {
		expect(toolDelta(measures({ p90: 5e6 }), measures({ p90: 5e6 }), "duration", "p90")).toMatchObject({
			text: "0ms",
			direction: "flat",
		})
	})
})
