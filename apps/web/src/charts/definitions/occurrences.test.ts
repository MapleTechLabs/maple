import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { buildOccurrences } from "./occurrences"

const points = [
	{ bucket: "2026-11-01 10:05:00", count: 1234 },
	{ bucket: "2026-11-01 10:00:00", count: 3 },
]

const built = buildOccurrences({ _tag: "Occurrences", points, color: "#e5484d", timeZone: "UTC" })

const hover = (point: (typeof points)[number] | undefined) =>
	Option.getOrUndefined(
		built.tooltipOf(
			point === undefined
				? []
				: [
						{
							key: "count",
							markId: "bars",
							group: null,
							groupLabel: "",
							datum: point,
							datumIndex: 0,
							xValue: new Date(0),
							yValue: point.count,
							x: 0,
							y: 0,
							color: "#e5484d",
						},
					],
		),
	)

describe("occurrences chart tooltip", () => {
	test("a hovered bucket reads its count in the chart's colour under the bucket's time", () => {
		const tooltip = hover(points[0])
		expect(tooltip?._tag).toBe("Bucket")
		if (tooltip?._tag !== "Bucket") return
		expect(tooltip.heading).toContain("10:05")
		expect(tooltip.rows).toEqual([
			{ label: "Occurrences", color: "#e5484d", dashed: false, value: "1,234" },
		])
	})

	test("nothing under the cursor hides the tooltip", () => {
		expect(hover(undefined)).toBeUndefined()
	})
})
