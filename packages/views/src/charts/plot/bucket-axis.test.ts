import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { makeBucketAxis } from "./bucket-axis"
import { formatBucketLabel } from "@maple/ui/lib/format"

const days = (count: number) =>
	Arr.makeBy(count, (index) => new Date(Date.UTC(2026, 10, 1 + index)).toISOString())

const tickLabels = (bucketIsos: ReadonlyArray<string>) => {
	const axis = makeBucketAxis(bucketIsos, "UTC")
	const ticks = axis.x.axis.ticks
	return Arr.map("values" in ticks ? ticks.values : [], (value) =>
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
		expect(makeBucketAxis(days(60), "UTC").x.axis.ticks).toMatchObject({ spacing: 104 })
		const hours = Arr.makeBy(48, (index) => new Date(Date.UTC(2026, 10, 1, index)).toISOString())
		expect(makeBucketAxis(hours, "UTC").x.axis.ticks).toMatchObject({ spacing: 104 })
	})

	it("names each UTC-midnight day by its own date for a viewer west of UTC", () => {
		const axis = makeBucketAxis(days(7), "America/Los_Angeles")
		const ticks = axis.x.axis.ticks
		const labels = Arr.map("values" in ticks ? ticks.values : [], (value) => ticks.format(value))
		expect(labels).toEqual(["Nov 1", "Nov 2", "Nov 3", "Nov 4", "Nov 5", "Nov 6", "Nov 7"])
		expect(axis.heading(days(1)[0] ?? "")).toMatch(/Nov 1/)
	})

	it("keeps labelling hourly buckets on the viewer's clock", () => {
		const hours = Arr.makeBy(48, (index) => new Date(Date.UTC(2026, 9, 20, index)).toISOString())
		const axis = makeBucketAxis(hours, "America/Los_Angeles")
		// 07:00 UTC is midnight in Los Angeles (PDT); UTC midnight is still the evening before.
		expect(axis.x.axis.ticks.format(new Date(Date.UTC(2026, 9, 20, 7)))).toBe("Oct 20")
		expect(axis.x.axis.ticks.format(new Date(Date.UTC(2026, 9, 20, 0)))).toMatch(/Oct 19/)
	})

	// The chart throws (and draws nothing) when an axis sets more than one tick policy.
	it("never sets both spacing and explicit values", () => {
		for (const buckets of [days(7), days(14), days(60)]) {
			const ticks = makeBucketAxis(buckets, "UTC").x.axis.ticks
			expect("spacing" in ticks && "values" in ticks).toBe(false)
		}
	})
})
