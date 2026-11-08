import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { makeBucketAxis } from "../bucket-axis"
import { formatBucketLabel } from "../../../lib/format"

const days = (count: number) =>
	Arr.makeBy(count, (index) => new Date(Date.UTC(2026, 10, 1 + index)).toISOString())

const tickLabels = (bucketIsos: ReadonlyArray<string>) => {
	const axis = makeBucketAxis(bucketIsos, "UTC")
	return Arr.map(axis.x.axis.ticks.values ?? [], (value) =>
		formatBucketLabel(value.toISOString(), axis.context, "tick"),
	)
}

describe("makeBucketAxis daily ticks", () => {
	it("ticks a week of daily buckets once per day, each label once", () => {
		const labels = tickLabels(days(7))
		expect(labels).toEqual(["Nov 1", "Nov 2", "Nov 3", "Nov 4", "Nov 5", "Nov 6", "Nov 7"])
	})

	it("ticks two weeks every other day", () => {
		const labels = tickLabels(days(14))
		expect(labels).toHaveLength(7)
		expect(new Set(labels).size).toBe(labels.length)
	})

	it("leaves long daily runs and hourly buckets to the scale", () => {
		expect(makeBucketAxis(days(60), "UTC").x.axis.ticks.values).toBeUndefined()
		const hours = Arr.makeBy(48, (index) => new Date(Date.UTC(2026, 10, 1, index)).toISOString())
		expect(makeBucketAxis(hours, "UTC").x.axis.ticks.values).toBeUndefined()
	})
})
