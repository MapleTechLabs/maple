import { describe, expect, it } from "vitest"
import { renderQueryData } from "../tools/query-data"
import { bucketLabels } from "./format-query-result"
import { renderToolDoc } from "./tool-doc"

describe("bucketLabels", () => {
	it("prints only the time within one day", () => {
		const { labels, lastIsPartial } = bucketLabels(
			["2026-09-01 10:00:00", "2026-09-01 11:00:00"],
			"2026-09-01 12:00:00",
		)
		expect(labels).toEqual(["10:00:00", "11:00:00"])
		expect(lastIsPartial).toBe(false)
	})

	it("prints the date once the series spans more than one day", () => {
		const { labels } = bucketLabels(
			["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"],
			"2026-09-04 00:00:00",
		)
		expect(labels).toEqual(["2026-09-01 00:00:00", "2026-09-02 00:00:00", "2026-09-03 00:00:00"])
	})

	it("marks a trailing bucket that runs past the window end", () => {
		const { labels, lastIsPartial } = bucketLabels(
			["2026-09-01 10:00:00", "2026-09-01 10:05:00"],
			"2026-09-01 10:07:30",
		)
		expect(lastIsPartial).toBe(true)
		expect(labels[1]).toBe("10:05:00 (partial)")
	})
})

describe("query_data timeseries rendering", () => {
	const output = (series: ReadonlyArray<Record<string, number>>) => ({
		timeRange: { start: "2026-09-01 10:00:00", end: "2026-09-01 10:12:00" },
		kind: "timeseries" as const,
		metric: "error_rate",
		queryContext: { source: "traces" as const },
		unit: "percent" as const,
		result: {
			kind: "timeseries" as const,
			data: series.map((s, i) => ({
				bucket: `2026-09-01 10:${String(i * 5).padStart(2, "0")}:00`,
				series: s,
			})),
		},
	})

	it("renders a bucket with no rows as no data, never as 0", () => {
		const text = renderToolDoc(renderQueryData(output([{ value: 0.5 }, {}, {}])))
		expect(text).toContain("| 10:05:00 | - |")
		expect(text).not.toContain("| 0.00% |")
		expect(text).toContain("no rows in that bucket")
		expect(text).toContain("10:10:00 (partial)")
	})
})
