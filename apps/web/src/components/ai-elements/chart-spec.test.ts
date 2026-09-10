import { expect, it } from "vitest"

import { normalizeUnit, parseChartSpec, rankedRows, timeseriesRows } from "./chart-spec"

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
	["prose", "the p95 climbed to 388ms"],
])("refuses %s", (_label, source) => {
	expect(parseChartSpec(source)).toBeNull()
})

it("keeps a chart whose unit is a shorthand, and falls back to plain numbers for one it cannot place", () => {
	expect(normalizeUnit("ms")).toBe("duration_ms")
	expect(normalizeUnit("%")).toBe("percent")
	expect(normalizeUnit("duration_ms")).toBe("duration_ms")
	expect(normalizeUnit("furlongs")).toBe("number")
	expect(normalizeUnit(undefined)).toBe("number")
})
