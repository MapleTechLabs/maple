import { describe, expect, test } from "vitest"
import { seriesRuns } from "../series-gaps"

const MINUTE = 60_000
const START = Date.UTC(2026, 10, 1, 12)

type Row = Readonly<{ at: Date; value: number | null }>

/** One row per bucket, `null` where the series has no reading. */
const series = (bucketMs: number, values: ReadonlyArray<number | null>): ReadonlyArray<Row> =>
	values.map((value, index) => ({ at: new Date(START + index * bucketMs), value }))

const runValues = (rows: ReadonlyArray<Row>) => {
	const { runs, lone } = seriesRuns(
		rows,
		(row) => row.value,
		(row) => row.at,
	)
	return { runs: runs.map((run) => run.map((row) => row.value)), lone: lone.map((row) => row.value) }
}

describe("seriesRuns", () => {
	test("on 1-minute buckets, up to five minutes of silence is bridged", () => {
		expect(runValues(series(MINUTE, [1, null, null, null, null, 2]))).toEqual({
			runs: [[1, 2]],
			lone: [],
		})
	})

	test("on 1-minute buckets, a longer silence breaks the line and leaves lone readings", () => {
		expect(runValues(series(MINUTE, [1, null, null, null, null, null, 2]))).toEqual({
			runs: [[1], [2]],
			lone: [1, 2],
		})
	})

	test("on coarse buckets, one empty bucket is bridged and two are not", () => {
		expect(runValues(series(15 * MINUTE, [1, null, 2, 3, null, null, 4, 5]))).toEqual({
			runs: [
				[1, 2, 3],
				[4, 5],
			],
			lone: [],
		})
	})

	test("rows without empty buckets still break when their timestamps are far apart", () => {
		const rows = [0, 1, 2, 30, 31].map((minute) => ({
			at: new Date(START + minute * MINUTE),
			value: minute,
		}))
		expect(runValues(rows).runs).toEqual([
			[0, 1, 2],
			[30, 31],
		])
	})
})
