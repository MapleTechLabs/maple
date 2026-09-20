/**
 * Golden SVGs, pinned before the alert and chat renderers were merged into one.
 *
 * The alert chart is live: its images are embedded in notifications that have
 * already been delivered, and a refactor that quietly moved a line by a pixel
 * would show up in a customer's channel, not in a test run. These snapshots
 * were captured from the two-function renderer, so the merged one has to
 * reproduce them exactly.
 *
 * Only the SVG is pinned — it is the drawing. The labels around it are type the
 * caller composes, and the tests beside this one assert those directly.
 *
 * Not a style guide: a deliberate visual change updates them. They exist so an
 * *unintended* one cannot pass.
 */
import { describe, expect, it } from "vitest"
import { renderChartSvg, unitColor, type ChartPoint } from "./static-chart"

const at = (minutesAgo: number): number => Date.UTC(2026, 7, 18, 14, 32) - minutesAgo * 60_000

const points = (values: ReadonlyArray<number>): ReadonlyArray<ChartPoint> =>
	values.map((v, i) => [at(values.length - 1 - i), v] as ChartPoint)

describe("the alert chart, which is already in delivered notifications", () => {
	const spec = {
		unit: "percent",
		series: [{ name: "checkout-api error rate", points: points([0.8, 1.2, 2.4, 3.9, 1.1, 0.6]) }],
		threshold: 2,
		breachSide: "above",
		// The alert chart takes its unit's semantic colour, not the palette's first.
		color: unitColor("percent"),
	} as const

	for (const kind of ["line", "area", "bar"] as const) {
		it(`draws ${kind} exactly as it did before the renderers merged`, () => {
			expect(renderChartSvg({ ...spec, kind }).svg).toMatchSnapshot()
		})
	}

	it("draws a downward breach band as it did before", () => {
		expect(renderChartSvg({ ...spec, kind: "line", breachSide: "below" }).svg).toMatchSnapshot()
	})

	it("draws no rule and no band when the rule has no threshold", () => {
		expect(renderChartSvg({ ...spec, kind: "area", threshold: null }).svg).toMatchSnapshot()
	})
})

describe("a chart out of a reply", () => {
	it("draws several series", () => {
		expect(
			renderChartSvg({
				kind: "line",
				unit: "duration_ms",
				series: [
					{ name: "checkout-api", points: points([142, 180, 260, 388]) },
					{ name: "cart-api", points: points([61, 58, 64, 70]) },
					{ name: "search-api", points: points([95, 120, 105, 98]) },
				],
			}).svg,
		).toMatchSnapshot()
	})
})
