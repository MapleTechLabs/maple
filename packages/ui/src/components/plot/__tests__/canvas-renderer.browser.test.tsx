import "../../../../test/browser.css"
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { QueryBuilderLineChart } from "../../charts/line/query-builder-line-chart"

afterEach(cleanup)

describe("native canvas rendering", () => {
	it("paints the default renderer and resizes through the real ResizeObserver", async () => {
		const data = Array.from({ length: 6 }, (_, index) => ({
			bucket: new Date(Date.UTC(2026, 8, 21, index)).toISOString(),
			api: 10 + index * 5,
		}))
		const { container } = render(
			<div style={{ width: 800, height: 400 }}>
				<QueryBuilderLineChart data={data} legend="hidden" />
			</div>,
		)
		const host = container.firstElementChild as HTMLDivElement
		const canvas = container.querySelector<HTMLCanvasElement>("canvas.ts-chart-canvas__scene")
		expect(canvas).not.toBeNull()
		if (!canvas) throw new Error("Expected the production canvas renderer")
		await waitFor(() => {
			expect(canvas.width).toBeGreaterThan(0)
			const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
			expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
		})
		const initialWidth = canvas.width
		host.style.width = "500px"
		await waitFor(() => expect(canvas.width).toBeLessThan(initialWidth))
	})
})
