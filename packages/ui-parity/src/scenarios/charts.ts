import type { AreaModule, Scenario } from "./types.ts"

/**
 * Chart interactions on `/lab/charts` (spike S3). A chart paints on a canvas, so nothing inside the
 * plot has a role: steps find the chart by its accessible `img` role and name, then hover a
 * position inside it. Positions are in the chart's own box (1440x900 viewport, gallery layout).
 */
const hover = (
	id: string,
	title: string,
	chartName: string,
	position: { x: number; y: number },
): Scenario => ({
	id: `lab-charts-hover-${id}`,
	title: `Lab: TanStack charts, ${title}`,
	path: "/lab/charts",
	viewports: ["desktop"],
	// The hovered chart only; `lab-charts` covers the whole page.
	fullPage: false,
	themes: ["light", "dark"],
	area: "charts",
	steps: async (page) => {
		await page.getByRole("img", { name: chartName }).first().hover({ position })
	},
})

export const chartsArea: AreaModule = {
	area: "charts",
	scenarios: [
		// Production pie: inside the api-gateway wedge (12 o'clock to 43%, clockwise). Grows the slice,
		// dims the rest, lights its legend row and shows the tooltip, all from one focus change.
		hover("pie", "hover a pie slice", "Share by category", { x: 286, y: 131 }),
		// Production histogram: a bin left of centre; the other bins fade and the count tooltip shows.
		hover("histogram", "hover a histogram bin", "Value distribution", { x: 300, y: 200 }),
	],
}
