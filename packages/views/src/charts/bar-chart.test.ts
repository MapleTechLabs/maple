import { MAX_BAR_SERIES, OTHER_LABEL } from "@maple/ui/components/charts/_shared/bucket-series"
import { Array as Arr, Record as Rec } from "effect"
import { describe, expect, test } from "vitest"
import { bucketBarSeries } from "./bar-chart"
import { seriesDefinitionsOf } from "./timeseries"

type Row = Readonly<Record<string, string | number | boolean>>

/** Two buckets of `seriesCount` series; series `sN` reads `N * scale`. */
const rowsOf = (seriesCount: number, scale = 1): ReadonlyArray<Row> =>
	Arr.map(["2026-10-01 12:00:00", "2026-10-01 12:01:00"], (bucket) => ({
		bucket,
		...Rec.fromEntries(
			Arr.makeBy(seriesCount, (index) => [`series-${index + 1}`, (index + 1) * scale] as const),
		),
	}))

describe("bucketBarSeries", () => {
	test("rows past the series cap fold once per rows array, so a re-render gets the same rows", () => {
		const rows = rowsOf(MAX_BAR_SERIES + 3)
		const bucketed = bucketBarSeries(rows)

		expect(Rec.keys(bucketed[0] ?? {})).toContain(OTHER_LABEL)
		expect(bucketBarSeries(rows)).toBe(bucketed)
	})

	test("another rows array is folded on its own values", () => {
		const bucketed = bucketBarSeries(rowsOf(MAX_BAR_SERIES + 3))
		const doubled = bucketBarSeries(rowsOf(MAX_BAR_SERIES + 3, 2))

		expect(doubled).not.toBe(bucketed)
		expect(doubled[0]?.[OTHER_LABEL]).toBe(Number(bucketed[0]?.[OTHER_LABEL]) * 2)
	})

	test("rows under the cap pass through", () => {
		const rows = rowsOf(MAX_BAR_SERIES)

		expect(bucketBarSeries(rows)).toBe(rows)
	})
})

describe("seriesDefinitionsOf", () => {
	test("the same rows array gets the same definitions back", () => {
		const rows = rowsOf(3)

		expect(seriesDefinitionsOf(rows)).toBe(seriesDefinitionsOf(rows))
		expect(seriesDefinitionsOf(rows).definitions).toEqual([
			{ rawKey: "series-1", chartKey: "s1" },
			{ rawKey: "series-2", chartKey: "s2" },
			{ rawKey: "series-3", chartKey: "s3" },
		])
	})

	test("another rows array gets its own definitions", () => {
		const three = seriesDefinitionsOf(rowsOf(3))
		const four = seriesDefinitionsOf(rowsOf(4))

		expect(four).not.toBe(three)
		expect(four.totalSeriesCount).toBe(4)
		expect(three.totalSeriesCount).toBe(3)
	})
})
