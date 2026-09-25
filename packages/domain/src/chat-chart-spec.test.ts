import { describe, expect, it } from "vitest"

import {
	chartFences,
	hasOpenFence,
	normalizeUnit,
	parseChartSpec,
	rankedRows,
	staticChartUnit,
	timeseriesRows,
} from "./chat-chart-spec"

const timeseries = JSON.stringify({
	type: "line",
	title: "p95 latency",
	unit: "ms",
	data: [
		{ bucket: "2026-09-11T10:00:00Z", series: { "checkout-api": 142 } },
		{ bucket: "2026-09-11T10:01:00Z", series: { "checkout-api": 388 } },
	],
})

it("reads a timeseries fence and flattens its series onto the rows a chart takes", () => {
	const spec = parseChartSpec(timeseries)
	expect(spec?.type).toBe("line")
	if (spec?.type === "ranked" || spec == null) throw new Error("expected a timeseries spec")
	expect(timeseriesRows(spec.data)).toEqual([
		{ bucket: "2026-09-11T10:00:00Z", "checkout-api": 142 },
		{ bucket: "2026-09-11T10:01:00Z", "checkout-api": 388 },
	])
})

it("reads a ranked fence", () => {
	const spec = parseChartSpec(
		JSON.stringify({ type: "ranked", data: [{ name: "TimeoutError", value: 412 }] }),
	)
	if (spec?.type !== "ranked") throw new Error("expected a ranked spec")
	expect(rankedRows(spec.data)).toEqual([{ name: "TimeoutError", value: 412 }])
})

it.each([
	["a truncated fence", '{"type":"line","data":[{"bucket":"2026-09-11T10:0'],
	["a chart type nothing renders", JSON.stringify({ type: "sankey", data: [{ name: "a", value: 1 }] })],
	["ranked points in a line chart", JSON.stringify({ type: "line", data: [{ name: "a", value: 1 }] })],
	["a non-numeric value", JSON.stringify({ type: "ranked", data: [{ name: "a", value: "many" }] })],
	["no rows at all", JSON.stringify({ type: "area", data: [] })],
	[
		"buckets that are not times",
		JSON.stringify({ type: "line", data: [{ bucket: "sometime", series: { api: 1 } }] }),
	],
	[
		"rows that name no series",
		JSON.stringify({ type: "line", data: [{ bucket: "2026-09-11T10:00:00Z", series: {} }] }),
	],
	["prose", "the p95 climbed to 388ms"],
])("refuses %s", (_label, source) => {
	expect(parseChartSpec(source)).toBeNull()
})

it("keeps a chart whose unit is a shorthand, and falls back to plain numbers for one it cannot place", () => {
	expect(normalizeUnit("ms")).toBe("duration_ms")
	expect(normalizeUnit("%")).toBe("percent_100")
	expect(normalizeUnit("percent")).toBe("percent_100")
	expect(normalizeUnit("fraction")).toBe("percent")
	expect(normalizeUnit("duration_ms")).toBe("duration_ms")
	expect(normalizeUnit("furlongs")).toBe("number")
	expect(normalizeUnit(undefined)).toBe("number")
})

it("drops the timeseries rows a chart cannot plot and keeps the rest", () => {
	const spec = parseChartSpec(
		JSON.stringify({
			type: "line",
			data: [
				{ bucket: "2026-09-11T10:00:00Z", series: { "checkout-api": 142 } },
				{ bucket: "not a time", series: { "checkout-api": 388 } },
				{ bucket: "2026-09-11T10:02:00Z", series: {} },
			],
		}),
	)
	if (spec?.type === "ranked" || spec == null) throw new Error("expected a timeseries spec")
	expect(timeseriesRows(spec.data)).toEqual([{ bucket: "2026-09-11T10:00:00Z", "checkout-api": 142 }])
})

it("lands every unit on one the image renderer knows, scaling the values with it", () => {
	expect(staticChartUnit("ms")).toEqual({ unit: "duration_ms", scale: 1 })
	expect(staticChartUnit("s")).toEqual({ unit: "duration_ms", scale: 1000 })
	expect(staticChartUnit("ns")).toEqual({ unit: "duration_ms", scale: 1 / 1_000_000 })
	// A fence's `percent` is the number as a reader says it; only the 0–1
	// aliases are scaled onto the renderer's 0–100 scale.
	expect(staticChartUnit("%")).toEqual({ unit: "percent", scale: 1 })
	expect(staticChartUnit("ratio")).toEqual({ unit: "percent", scale: 100 })
	expect(staticChartUnit("bytes")).toEqual({ unit: "bytes", scale: 1 })
	expect(staticChartUnit("furlongs")).toEqual({ unit: "number", scale: 1 })
})

describe("chartFences", () => {
	it("returns the charts of a reply in the order they appear in it", () => {
		const reply = [
			"Latency climbed after the deploy.",
			"```chart",
			'{"type":"line","data":[]}',
			"```",
			"And the errors with it:",
			"```chart",
			'{"type":"ranked","data":[]}',
			"```",
		].join("\n")

		expect(chartFences(reply)).toEqual(['{"type":"line","data":[]}', '{"type":"ranked","data":[]}'])
	})

	it("ignores fences that are not charts, and does not let them shift the index", () => {
		const reply = ["```sql", "SELECT 1", "```", "```chart", '{"type":"bar"}', "```"].join("\n")

		expect(chartFences(reply)).toEqual(['{"type":"bar"}'])
	})

	it("keeps a chart that holds a line of backticks of its own", () => {
		const reply = ["````chart", '{"note":"```"}', "````"].join("\n")

		expect(chartFences(reply)).toEqual(['{"note":"```"}'])
	})

	it("keeps an unclosed trailing chart, so the charts before it keep their positions", () => {
		const reply = ["```chart", '{"type":"line","data":[]}', "```", "```chart", '{"type":"ar'].join("\n")

		expect(chartFences(reply)).toHaveLength(2)
		expect(parseChartSpec(chartFences(reply)[1] ?? "")).toBeNull()
	})

	it("finds nothing in a reply that is only prose", () => {
		expect(chartFences("the p95 climbed to 388ms")).toEqual([])
	})
})

describe("hasOpenFence", () => {
	it("agrees with the scan a caller would otherwise re-derive", () => {
		expect(hasOpenFence("plain prose")).toBe(false)
		expect(hasOpenFence(["```chart", '{"type":"bar"}'].join("\n"))).toBe(true)
		expect(hasOpenFence(["```chart", '{"type":"bar"}', "```"].join("\n"))).toBe(false)
		// A run of backticks inside a longer fence is payload, not the fence closing.
		expect(hasOpenFence(["````chart", '{"note":"```"}'].join("\n"))).toBe(true)
		expect(hasOpenFence(["````chart", '{"note":"```"}', "````"].join("\n"))).toBe(false)
		// Backticks mid-line open nothing: a fence is a line construct.
		expect(hasOpenFence("write ``` to open a fence")).toBe(false)
	})
})
