import { describe, expect, it } from "vitest"

import { bucketCategorical, bucketTimeseries, MAX_CATEGORICAL, OTHER_LABEL } from "../bucket-series"
import { Array as Arr } from "effect"

describe("bucketCategorical", () => {
	it("sorts by value descending without bucketing when within the cap", () => {
		const out = bucketCategorical([
			{ name: "a", value: 1 },
			{ name: "b", value: 3 },
			{ name: "c", value: 2 },
		])
		expect(Arr.map(out, (r) => r.name)).toEqual(["b", "c", "a"])
		expect(Arr.some(out, (r) => r.name === OTHER_LABEL)).toBe(false)
	})

	it("collapses the long tail into a single Other bucket", () => {
		const rows = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, value: 20 - i }))
		const out = bucketCategorical(rows, 5)
		expect(out).toHaveLength(5)
		const other = out.at(-1)!
		expect(other.name).toBe(OTHER_LABEL)
		// Top 4 are 20,19,18,17; Other sums the remaining 16 values (16..1 = 136).
		const total = Arr.reduce(rows, 0, (s, r) => s + r.value)
		const head = Arr.reduce(out.slice(0, 4), 0, (s, r) => s + r.value)
		expect(other.value).toBe(total - head)
	})

	it("returns rows unchanged (sorted) when exactly at the cap", () => {
		const rows = Array.from({ length: MAX_CATEGORICAL }, (_, i) => ({
			name: `s${i}`,
			value: i,
		}))
		const out = bucketCategorical(rows)
		expect(out).toHaveLength(MAX_CATEGORICAL)
		expect(Arr.some(out, (r) => r.name === OTHER_LABEL)).toBe(false)
	})
})

describe("bucketTimeseries", () => {
	const rows = [
		{ bucket: "t0", a: 1, b: 10, c: 100, d: 2 },
		{ bucket: "t1", a: 1, b: 10, c: 100, d: 2 },
	]
	const keys = ["a", "b", "c", "d"]

	it("passes through when within the cap", () => {
		const out = bucketTimeseries(rows, keys, 10)
		expect(out.keys).toEqual(keys)
		expect(out.rows).toEqual(rows)
	})

	it("keeps top keys by magnitude and sums the rest into Other", () => {
		const out = bucketTimeseries(rows, keys, 3)
		// Ranked by total magnitude: c (200) > b (20) > d (4) > a (2).
		expect(out.keys).toEqual(["c", "b", OTHER_LABEL])
		// Other = a (1) + d (2).
		expect(out.rows[0]).toMatchObject({ bucket: "t0", c: 100, b: 10, [OTHER_LABEL]: 3 })
	})
})
