import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { getByRole, given, Mount, scene, tap } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import {
	HistogramMessage,
	MountRangeHistogram,
	type RangeBucket,
	type RangeHistogramMountRequirements,
	rangeHistogram,
} from "./range-histogram"

const before: ReadonlyArray<RangeBucket> = [
	{ from: 0, to: 100, count: 3 },
	{ from: 100, to: 200, count: 1 },
]
const after: ReadonlyArray<RangeBucket> = [
	{ from: 0, to: 500, count: 2 },
	{ from: 500, to: 1000, count: 4 },
]

const view = (
	buckets: ReadonlyArray<RangeBucket>,
	h: HtmlBuilder<HistogramMessage, RangeHistogramMountRequirements>,
): Html =>
	rangeHistogram(h, {
		buckets,
		unit: "ms",
		unitLabel: "sessions",
		title: "Duration",
		minValue: undefined,
		maxValue: undefined,
		hoveredIndex: undefined,
		toMessage: (message) => message,
	}) ?? h.div([], [])

// A refetch that returns new buckets: the test's update swaps them when the pointer leaves.
const update = (buckets: ReadonlyArray<RangeBucket>, message: HistogramMessage) => ({
	model: message._tag === "LeftHistogram" ? after : buckets,
	commands: [],
})

// Scene matches Mounts by name only, so the remount shows as the bar container's patch key.
const recordBarsKey = (keys: Array<unknown>) =>
	tap<ReadonlyArray<RangeBucket>, HistogramMessage>((simulation) => {
		keys.push(Option.getOrUndefined(getByRole("img")(simulation.html))?.key)
	})

describe("range histogram", () => {
	test("new buckets remount the pointer handlers, which captured the old bounds", () => {
		const keys: Array<unknown> = []
		scene(
			{ update, view },
			given(before),
			Mount.expectHas(MountRangeHistogram),
			recordBarsKey(keys),
			Mount.resolve(MountRangeHistogram, HistogramMessage.LeftHistogram()),
			recordBarsKey(keys),
			// The old bounds' handlers end and a fresh acquisition takes the new bounds.
			Mount.expectEnded(MountRangeHistogram),
			Mount.expectHas(MountRangeHistogram),
			Mount.resolve(MountRangeHistogram, HistogramMessage.LeftHistogram()),
		)
		expect(keys).toHaveLength(2)
		expect(keys[0]).not.toEqual(keys[1])
	})
})
