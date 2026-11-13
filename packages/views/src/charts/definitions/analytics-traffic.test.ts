import { Array as Arr, Option } from "effect"
import { describe, expect, test } from "vitest"
import type { ChartSpec } from "../chart-spec"
import { buildAnalyticsTraffic } from "./analytics-traffic"

type TrafficSpec = Extract<ChartSpec, { readonly _tag: "AnalyticsTraffic" }>

const BUCKET = "2026-11-07T00:00:00Z"

const spec = (
	value: number,
	series: TrafficSpec["series"][number],
	valueFormat?: TrafficSpec["valueFormat"],
): TrafficSpec => ({
	_tag: "AnalyticsTraffic",
	points: [{ bucket: BUCKET, primary: value }],
	series: [series],
	tickMetric: "sessions",
	colors: { primary: "#f80", companion: "#08f", border: "#ccc", background: "#fff" },
	timeZone: "UTC",
	gradientPrefix: "test",
	isNarrow: false,
	...(valueFormat === undefined ? null : { valueFormat }),
})

/** The tooltip's rows for the one bucket, as `[label, value]`. */
const hover = (traffic: TrafficSpec) => {
	const built = buildAnalyticsTraffic(traffic)
	const date = new Date(BUCKET)
	const tooltip = Option.getOrUndefined(
		built.tooltipOf([
			{
				key: "primary",
				markId: "primary:0",
				group: null,
				groupLabel: "",
				datum: { bucket: BUCKET, date, primary: traffic.points[0]?.primary ?? null },
				datumIndex: 0,
				xValue: date,
				yValue: 0,
				x: 0,
				y: 0,
				color: "#f80",
			},
		]),
	)
	return tooltip?._tag === "Bucket" ? Arr.map(tooltip.rows, (row) => [row.label, row.value]) : undefined
}

describe("analytics traffic chart tooltip", () => {
	test("a labelled series is a count unless the spec says how it reads", () => {
		expect(hover(spec(1280, { key: "primary", metric: "search-clicks", label: "Clicks" }))).toEqual([
			["Clicks", "1.3K"],
		])
	})

	test("a ratio reads as a percentage and a position with one decimal", () => {
		expect(hover(spec(0.037, { key: "primary", metric: "search-ctr", label: "CTR" }, "percent"))).toEqual(
			[["CTR", "3.7%"]],
		)
		expect(
			hover(
				spec(6.42, { key: "primary", metric: "search-position", label: "Avg position" }, "decimal"),
			),
		).toEqual([["Avg position", "6.4"]])
	})
})
