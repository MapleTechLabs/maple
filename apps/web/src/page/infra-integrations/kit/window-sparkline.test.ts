import { describe, expect, test } from "vitest"
import { sparkSegments } from "./window-sparkline"

const MINUTE = 60_000
const start = Date.parse("2026-10-21T17:00:00Z")
// A 6 hour window at 5 minute buckets.
const window = { startMs: start, endMs: start + 360 * MINUTE, bucketMs: 5 * MINUTE }
const at = (minutes: number) => new Date(start + minutes * MINUTE).toISOString()

describe("sparkSegments", () => {
	test("places points by timestamp across the window, so recent data sits at the right end", () => {
		const runs = sparkSegments(
			[
				{ bucket: at(345), value: 1 },
				{ bucket: at(350), value: 3 },
				{ bucket: at(355), value: 2 },
			],
			window,
		)
		expect(runs).toHaveLength(1)
		expect(runs[0]?.map(([x]) => Number(x.toFixed(2)))).toEqual([95.83, 97.22, 98.61])
	})

	test("a missing bucket or a null value breaks the line instead of bridging it", () => {
		const runs = sparkSegments(
			[
				{ bucket: at(0), value: 1 },
				{ bucket: at(5), value: 2 },
				// 10 is missing.
				{ bucket: at(15), value: 2 },
				{ bucket: at(20), value: null },
				{ bucket: at(25), value: 1 },
			],
			window,
		)
		expect(runs.map((run) => run.length)).toEqual([2, 1, 1])
	})

	test("the highest value draws at the top and the lowest at the bottom; a flat series in the middle", () => {
		const [run] = sparkSegments(
			[
				{ bucket: at(0), value: 0 },
				{ bucket: at(5), value: 10 },
			],
			window,
		)
		expect(run?.map(([, y]) => y)).toEqual([26, 2])
		const [flat] = sparkSegments([{ bucket: at(0), value: 4 }], window)
		expect(flat?.[0]?.[1]).toBe(14)
	})

	test("nothing to draw without a value", () => {
		expect(sparkSegments([{ bucket: at(0), value: null }], window)).toEqual([])
	})
})
