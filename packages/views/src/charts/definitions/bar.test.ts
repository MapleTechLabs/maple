import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import type { TimeseriesRow } from "../timeseries-rows"
import { cellsOf } from "./bar"

const SERIES = [
	{ key: "s1", label: "api", color: "red" },
	{ key: "s2", label: "web", color: "green" },
	{ key: "s3", label: "worker", color: "blue" },
]

const row = (minute: number, values: Readonly<Record<string, number>>): TimeseriesRow => ({
	bucket: `2026-10-01 12:0${minute}:00`,
	date: new Date(Date.UTC(2026, 9, 1, 12, minute)),
	...values,
})

/** The series keys whose cell is the top of its column, one entry per bucket. */
const topsOf = (rows: ReadonlyArray<TimeseriesRow>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(rows, (bucket) =>
		Arr.map(
			Arr.filter(cellsOf(rows, SERIES, -1, true), (cell) => cell.row === bucket && cell.top),
			(cell) => cell.key,
		),
	)

describe("cellsOf", () => {
	test("the top of a stack is its last series with a value, not the last series", () => {
		const rows = [
			row(0, { s1: 5, s2: 3, s3: 0 }),
			row(1, { s1: 0, s2: 0, s3: 2 }),
			row(2, { s1: 4, s2: 0, s3: 0 }),
		]

		expect(topsOf(rows)).toEqual([["s2"], ["s3"], ["s1"]])
	})

	test("an empty bucket has no top", () => {
		expect(topsOf([row(0, { s1: 0, s2: 0, s3: 0 })])).toEqual([[]])
	})

	test("a stacked cell starts where the series under it end", () => {
		const cells = cellsOf([row(0, { s1: 5, s2: 3, s3: 2 })], SERIES, -1, true)

		expect(Arr.map(cells, (cell) => cell.base)).toEqual([0, 5, 8])
	})
})
