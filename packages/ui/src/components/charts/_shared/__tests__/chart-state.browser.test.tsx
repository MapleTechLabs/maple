/**
 * The point of `ChartPlotArea` is that a chart's loading, empty and error
 * branches cannot reserve a different box than the plot they stand in for.
 * Before it, each branch carried its own `h-[280px]` literal and they drifted.
 * These pin the sizing contract that replaced those literals.
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ChartEmpty, ChartPlotArea, useChartPlotHeight } from "../chart-state"

afterEach(cleanup)

function HeightProbe() {
	return <span data-testid="probe">{String(useChartPlotHeight())}</span>
}

describe("ChartPlotArea", () => {
	it("reserves the declared height and publishes it to descendants", () => {
		const { getByTestId, container } = render(
			<ChartPlotArea height={280}>
				<HeightProbe />
			</ChartPlotArea>,
		)

		const area = container.querySelector("[data-slot='chart-plot-area']")
		expect(area).toHaveProperty("style.height", "280px")
		expect(getByTestId("probe").textContent).toBe("280")
	})

	it("reports no height outside a provider, so a chart can fall back", () => {
		const { getByTestId } = render(<HeightProbe />)
		expect(getByTestId("probe").textContent).toBe("null")
	})
})

describe("chart states inside a plot area", () => {
	it("lets an explicit height override the inherited one", () => {
		const { container } = render(
			<ChartPlotArea height={280}>
				<ChartEmpty height={120}>No data</ChartEmpty>
			</ChartPlotArea>,
		)

		const box = container.querySelector("[data-slot='chart-plot-area'] > div")
		expect(box).toHaveProperty("style.height", "120px")
	})
})
