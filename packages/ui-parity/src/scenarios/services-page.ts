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

/** On `services-edge` (fixtures/areas/services.ts): an unnamed and a head-sampled service. */
const edge = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	...services(id, title, steps),
	dataset: "services-edge",
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
		// Intent preload: the router warms the target's loader atoms 50 ms after hover or focus.
		services(
			"preload-hover",
			"the sidebar's Services link hovered from the overview",
			async (page) => {
				await page.getByRole("link", { name: "Services", exact: true }).first().hover()
				await page.waitForTimeout(300)
			},
			"/",
		),
		services(
			"preload-focus",
			"the sidebar's Explore (traces) link focused from the services list",
			async (page) => {
				await page.getByRole("link", { name: "Explore", exact: true }).focus()
				await page.waitForTimeout(300)
			},
		),
		services(
			"preload-filtered-link",
			"the overview's View all services link (window and environment) hovered",
			async (page) => {
				await page.getByRole("link", { name: "View all services", exact: true }).hover()
				await page.waitForTimeout(300)
			},
			"/",
		),
		services("rollout-tooltip", "a mid-rollout deploy's split tooltip", async (page) => {
			await servicesTable(page).getByRole("button", { name: /^\d+% · \+\d+$/ }).first().hover()
			await page.waitForTimeout(900)
		}),
		services("commit-card", "a deploy's commit hover card", async (page) => {
			await servicesTable(page).getByText("release(storefront): 5.9.0", { exact: true }).hover()
			await page.getByText("View on GitHub").waitFor()
		}),
		// `sessionTimeRangeSearchMiddleware`: the window picked here opens the next time-filtered page.
		services("session-range", "the 1 day window carried to the traces page", async (page) => {
			await page.getByRole("button", { name: "Last 12 hours" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
			await page.getByRole("link", { name: "Explore", exact: true }).click()
			await page.waitForURL(/\/traces\?timePreset=1d/)
		}),
		services("only-environment", "production only, from its row's Only action", async (page) => {
			await page.getByText("production", { exact: true }).first().hover()
			await page.getByRole("button", { name: "Show only production" }).click()
			await page.waitForURL(/environments=/)
		}),
		services("health-filter", "healthy services only, from the Health facet", async (page) => {
			await page.getByRole("checkbox", { name: "healthy", exact: true }).click()
			await page.waitForURL(/health=healthy/)
		}),
		// Opened filtered, so clearing lands on a window neither app has fetched yet.
		services(
			"clear-filters",
			"a filter cleared from the rail header",
			async (page) => {
				await page.getByRole("button", { name: /^Clear/ }).first().click()
				await page.waitForURL((url) => !url.search.includes("environments"))
			},
			"/services?environments=%5B%22production%22%5D",
		),
		services("row-open", "a service row opened", async (page) => {
			await servicesTable(page).getByRole("row").nth(3).click({ position: { x: 600, y: 10 } })
			await page.waitForURL(/\/services\/[^?]+\?/)
		}),
		services("reload", "Reload pressed", async (page) => {
			await page.getByRole("button", { name: "Reload" }).click()
			await page.waitForTimeout(300)
		}),
		services("alt-exclude", "production excluded by Alt+clicking its label", async (page) => {
			await page.getByText("production", { exact: true }).first().click({ modifiers: ["Alt"] })
			await page.getByText("No services match these filters").first().waitFor()
		}),
		edge("edge","an unnamed and a sampled service", async (page) => {
			await servicesTable(page).getByRole("row").nth(2).waitFor()
		}),
		edge("unnamed-hint", "the no service.name hint's tooltip", async (page) => {
			await servicesTable(page).getByText("no service.name").hover()
			await page.getByText("OTEL_SERVICE_NAME").waitFor()
		}),
		edge("sampling-tooltip", "a sampled service's throughput estimate tooltip", async (page) => {
			await servicesTable(page).getByRole("button", { name: /^Throughput:/ }).last().hover()
			await page.getByText(/^Estimated from/).waitFor()
		}),
		services("time-range", "last 24 hours from the time range picker", async (page) => {
			await page.getByRole("button", { name: "Last 12 hours" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
		}),
	],
}
