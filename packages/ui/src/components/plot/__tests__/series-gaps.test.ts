import { describe, expect, test } from "vitest"
import { seriesRuns } from "../series-gaps"
import { Array as Arr } from "effect"

const MINUTE = 60_000
const START = Date.UTC(2026, 10, 1, 12)

type Row = Readonly<{ at: Date; value: number | null }>

/** One row per bucket, `null` where the series has no reading. */
const series = (bucketMs: number, values: ReadonlyArray<number | null>): ReadonlyArray<Row> =>
	Arr.map(values, (value, index) => ({ at: new Date(START + index * bucketMs), value }))

const runValues = (rows: ReadonlyArray<Row>) => {
	const { runs, lone } = seriesRuns(
		rows,
		(row) => row.value,
		(row) => row.at,
	)
	return {
		runs: Arr.map(runs, (run) => Arr.map(run, (row) => row.value)),
		lone: Arr.map(lone, (row) => row.value),
	}
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

	test("each silence runs from one run's last reading to the next run's first", () => {
		const { silences } = seriesRuns(
			series(15 * MINUTE, [1, 2, null, null, 3, null, null, null, 4]),
			(row) => row.value,
			(row) => row.at,
		)
		expect(Arr.map(silences, (silence) => [silence.from.value, silence.to.value])).toEqual([
			[2, 3],
			[3, 4],
		])
	})

	test("rows without empty buckets still break when their timestamps are far apart", () => {
		const rows = Arr.map([0, 1, 2, 30, 31], (minute) => ({
			at: new Date(START + minute * MINUTE),
			value: minute,
		}))
		expect(runValues(rows).runs).toEqual([
			[0, 1, 2],
			[30, 31],
		])
	})
})
