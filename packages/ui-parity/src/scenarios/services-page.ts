import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * `/services` interactions on dataset `default`. The services table has no sortable columns, so the
 * table-ordering interaction is the grouping switch (Namespace / Environment), which reorders rows.
 */
const services = (
	id: string,
	title: string,
	steps: (page: Page) => Promise<void>,
	path = "/services",
): Scenario => ({
	id: `services-${id}`,
	title: `Services: ${title}`,
	path,
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	area: "services",
})

const servicesTable = (page: Page) => page.getByRole("table", { name: "Services" })

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const timed = (
	id: string,
	title: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
): Scenario => ({
	id: `services-${id}`,
	title: `Services: ${title}`,
	path: "/services",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	faults,
	settle,
	area: "services",
})

export const servicesPageArea: AreaModule = {
	area: "services",
	scenarios: [
		timed(
			"loading",
			"loading (execute-batch held)",
			{ delays: { "queryEngine.executeBatch": HELD_MS } },
			"held",
		),
		timed(
			"error",
			"execute-batch failing",
			{
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
			"quiet",
		),
		services("group-by-environment", "grouped by environment", async (page) => {
			await page
				.getByRole("group", { name: "Group services by" })
				.getByRole("button", { name: "Environment" })
				.click()
			await servicesTable(page).getByRole("row").nth(1).waitFor()
		}),
		services("environment-filter", "production only, from the sidebar", async (page) => {
			await page.getByRole("checkbox", { name: "production", exact: true }).click()
			await page.getByText("Environment", { exact: true }).last().waitFor()
		}),
		services("exclude-environment", "production excluded (filtered empty)", async (page) => {
			await page.getByText("production", { exact: true }).first().hover()
			await page.getByRole("button", { name: "Exclude production" }).click()
			await page.getByText("No services match these filters").first().waitFor()
		}),
		services("row-hover", "a service row hovered over its error-rate sparkline", async (page) => {
			await servicesTable(page)
				.getByRole("img", { name: /^Error rate:/ })
				.first()
				.hover()
		}),
		services("time-range", "last 24 hours from the time range picker", async (page) => {
			await page.getByRole("button", { name: "Last 12 hours" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
		}),
	],
}
