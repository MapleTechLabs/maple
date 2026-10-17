import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Interaction states of the two xyflow canvases (spike S5): `/lab/flow` and a small
 * `/lab/bench/service-map` graph that lays out quickly. Ids keep the lab prefix so
 * `--filter lab-flow` and `--filter lab-bench-service-map` include them.
 */
const SMALL_MAP = "/lab/bench/service-map?services=8&edges=12&rps=med&seed=3"

const variant = (
	id: string,
	title: string,
	path: string,
	steps: (page: Page) => Promise<void>,
): Scenario => ({
	id,
	title,
	path,
	// Signed in like the rest of the lab area: the lab shell boots the app's session checks.
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "lab",
	steps,
})

/** Wheel over the canvas centre. The canvas is React Flow's `role="application"` wrapper. */
const wheelZoom = (deltaY: number) => async (page: Page) => {
	const box = await page.getByRole("application").boundingBox()
	if (box === null) throw new Error("canvas has no box")
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.wheel(0, deltaY)
}

/** ELK runs in a worker; the canvas reports `data-elk-status="ready"` once its final layout landed. */
const waitForMap = async (page: Page) => {
	await page.waitForFunction(
		() => document.querySelector('[data-elk-status="ready"]') !== null,
		undefined,
		{
			timeout: 30_000,
		},
	)
}

export const labCanvasArea: AreaModule = {
	area: "lab",
	scenarios: [
		variant("lab-flow-hover-node", "Lab: Trace flow, node hovered", "/lab/flow", async (page) => {
			await page.getByText("checkout-edge fetch").hover()
		}),
		variant("lab-flow-select-node", "Lab: Trace flow, node selected", "/lab/flow", async (page) => {
			await page.getByText("PricingEngine.calculateTotals").click()
		}),
		variant("lab-flow-wheel-zoom", "Lab: Trace flow, wheel zoom", "/lab/flow", wheelZoom(-400)),
		variant("lab-bench-service-map-small", "Lab: Service map, small graph", SMALL_MAP, waitForMap),
		variant(
			"lab-bench-service-map-hover-node",
			"Lab: Service map, node hovered",
			SMALL_MAP,
			async (page) => {
				await waitForMap(page)
				await page.getByText("svc-005").hover()
			},
		),
		variant(
			"lab-bench-service-map-wheel-zoom",
			"Lab: Service map, wheel zoom",
			SMALL_MAP,
			async (page) => {
				await waitForMap(page)
				await wheelZoom(300)(page)
			},
		),
	],
}
