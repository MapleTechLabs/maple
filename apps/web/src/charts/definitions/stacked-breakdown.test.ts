import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { transformRows } from "../infra-metric-series"
import { buildStackedBreakdown } from "./stacked-breakdown"

const rows = [
	{ bucket: "2026-10-26T10:00:00.000Z", attributeValue: "DNS", value: 4 },
	{ bucket: "2026-10-26T10:00:00.000Z", attributeValue: "TTFB", value: 60.5 },
]

const spec = (extra: { unit?: "duration_ms"; showTotal?: boolean } = {}) => ({
	_tag: "StackedBreakdown" as const,
	rows,
	series: ["DNS", "TTFB"],
	labels: { DNS: "DNS", TTFB: "TTFB" },
	colors: { DNS: "#0af", TTFB: "#f80", border: "#ccc", background: "#fff" },
	timeZone: "UTC",
	gradientPrefix: "test",
	...extra,
})

const hover = (built: ReturnType<typeof buildStackedBreakdown>) => {
	const row = transformRows(rows).data[0]
	if (row === undefined) return undefined
	const tooltip = Option.getOrUndefined(
		built.tooltipOf([
			{
				key: "DNS",
				markId: "area",
				group: "DNS",
				groupLabel: "DNS",
				datum: { row, name: "DNS", value: 4, bottom: 0, top: 4 },
				datumIndex: 0,
				xValue: row.date,
				yValue: 4,
				x: 0,
				y: 0,
				color: "#0af",
			},
		]),
	)
	return tooltip?._tag === "Bucket" ? tooltip : undefined
}

describe("stacked breakdown tooltip", () => {
	test("in milliseconds it lists each series as a duration and closes with their sum", () => {
		const tooltip = hover(buildStackedBreakdown(spec({ unit: "duration_ms", showTotal: true })))
		expect(tooltip?.rows.map((row) => [row.label, row.value])).toEqual([
			["DNS", "4.0ms"],
			["TTFB", "60.5ms"],
		])
		expect(tooltip?.total).toBe("64.5ms")
	})

	test("without a unit it keeps plain counts and no total", () => {
		const tooltip = hover(buildStackedBreakdown(spec()))
		expect(tooltip?.rows.map((row) => row.value)).toEqual(["4", "60.5"])
		expect(tooltip?.total).toBeUndefined()
	})
})
