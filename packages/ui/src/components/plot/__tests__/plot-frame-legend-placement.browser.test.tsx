import { defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { PlotFrame } from "../plot-frame"

// jsdom lays nothing out, so this proves which of the two arms rendered and
// where the legend slot sits in the DOM, not the measured layout.
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		width: 800,
		height: 400,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

const rows = [
	{ x: 0, y: 1 },
	{ x: 1, y: 4 },
	{ x: 2, y: 2 },
]

const definition = defineChart({
	marks: [lineY(rows, { x: (row: { x: number }) => row.x, y: (row: { y: number }) => row.y })],
	scales: {
		x: { scale: scaleLinear() },
		y: { scale: scaleLinear() },
	},
})

function frame(props: { legendPlacement?: "bottom" | "right"; legend?: boolean; footer?: boolean }) {
	return render(
		<PlotFrame
			definition={definition}
			ariaLabel="Demo"
			legend={props.legend === false ? undefined : <div data-testid="legend">key</div>}
			legendPlacement={props.legendPlacement}
			footer={props.footer ? <div data-testid="footer">note</div> : undefined}
		/>,
	)
}

/** The element the legend node was placed in — the frame's slot, not the node. */
function legendSlot(container: HTMLElement): HTMLElement {
	const node = container.querySelector("[data-testid='legend']")?.parentElement
	if (!(node instanceof HTMLElement)) throw new Error("expected the legend slot")
	return node
}

function plotBox(container: HTMLElement): HTMLElement {
	const anchor = container.querySelector("[data-chart-plot]")?.parentElement
	if (!(anchor instanceof HTMLElement)) throw new Error("expected the measured plot box")
	return anchor
}

describe("PlotFrame legend placement", () => {
	it.each([undefined, "bottom" as const])("stacks the legend below the plot for %s", (placement) => {
		const { container } = frame({ legendPlacement: placement })
		expect(container.querySelector("[data-chart-legend-row]")).toBeNull()
		// The host is a column, so the slot right after the plot box sits under it.
		expect(legendSlot(container).parentElement).toBe(container.querySelector("[data-chart-host]"))
		expect(plotBox(container).nextElementSibling).toBe(legendSlot(container))
	})

	it("puts the legend beside the plot on the right", () => {
		const { container } = frame({ legendPlacement: "right" })

		const row = container.querySelector("[data-chart-legend-row]")
		if (!(row instanceof HTMLElement)) throw new Error("expected the row wrapper")

		// The legend is a SIBLING of the measured plot box inside that row, which
		// is what makes it sit beside the plot rather than under it.
		expect(legendSlot(container).parentElement).toBe(row)
		expect(plotBox(container).parentElement).toBe(row)
	})

	it("ignores the placement when there is no legend to place", () => {
		const { container } = frame({ legendPlacement: "right", legend: false })
		expect(container.querySelector("[data-chart-legend-row]")).toBeNull()
	})

	it("keeps the footer under the whole figure, not beside the legend", () => {
		const { container } = frame({ legendPlacement: "right", footer: true })
		const row = container.querySelector("[data-chart-legend-row]")
		const footer = container.querySelector("[data-testid='footer']")?.parentElement
		expect(footer?.parentElement).toBe(container.querySelector("[data-chart-host]"))
		expect(footer?.parentElement).not.toBe(row)
	})
})
