import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** `/` (Overview) states and interactions on dataset `default`. */
const overview = (
	id: string,
	title: string,
	options: Pick<Scenario, "faults" | "settle" | "steps" | "fullPage">,
): Scenario => ({
	id: `overview-${id}`,
	title: `Overview: ${title}`,
	path: "/",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...options,
	area: "overview",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const pickPreset = async (page: Page, label: string) => {
	await page.getByRole("button", { name: "Last 24 hours" }).click()
	await page.getByRole("dialog").getByRole("button", { name: label }).click()
	await page.getByRole("dialog").waitFor({ state: "detached" })
}

export const overviewPageArea: AreaModule = {
	area: "overview",
	scenarios: [
		overview("loading", "loading (execute-batch held)", {
			faults: { delays: { "queryEngine.executeBatch": HELD_MS } },
			settle: "held",
		}),
		overview("error", "execute-batch failing", {
			faults: {
				failures: {
					"queryEngine.executeBatch": {
						status: 502,
						body: {
							_tag: "@maple/http/errors/QueryEngineExecutionError",
							message: "ui-parity: injected execute-batch failure",
						},
					},
				},
			},
			settle: "quiet",
		}),
		// The dataset has one environment, and picking "All environments" falls back to it, so the
		// interaction captured is the open list. First viewport only: growing the viewport for a
		// full-page capture closes Base UI's item-aligned Select.
		overview("environment-open", "environment dropdown open", {
			fullPage: false,
			steps: async (page) => {
				await page.getByRole("combobox").filter({ hasText: "production" }).click()
				await page.getByRole("option", { name: "All environments" }).waitFor()
			},
		}),
		// The hovered chart's tooltip bolds the series nearest the pointer; its siblings draw the
		// linked cursor line at the same time ratio.
		overview("chart-hover", "the latency chart hovered, with the linked cursor", {
			fullPage: false,
			steps: async (page) => {
				const latency = page.getByRole("img", { name: "Latency percentiles" })
				await latency.hover({ position: { x: 260, y: 120 } })
				await latency.hover({ position: { x: 280, y: 186 } })
				await page.waitForTimeout(300)
			},
		}),
		overview("time-range", "last 6 hours from the time range picker", {
			steps: (page) => pickPreset(page, "Last 6 hours"),
		}),
	],
}
