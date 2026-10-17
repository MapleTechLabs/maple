import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** `/traces` interactions, and the loading and error states, on dataset `default`. */
const list = (id: string, title: string, options: Partial<Scenario> = {}): Scenario => ({
	id: `traces-list-${id}`,
	title: `Traces list: ${title}`,
	path: "/traces",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "traces",
	...options,
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const tracesTable = (page: Page) => page.getByRole("table", { name: "Traces" })
const firstRowSettled = (page: Page) => tracesTable(page).getByRole("row").nth(1).waitFor()

export const tracesPageArea: AreaModule = {
	area: "traces",
	scenarios: [
		list("loading", "loading (execute-batch held)", {
			faults: { delays: { "queryEngine.executeBatch": HELD_MS } },
			settle: "held",
		}),
		list("error", "execute-batch failing", {
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
		list("has-error", "errors only, from the sidebar", {
			steps: async (page) => {
				await page.getByText("Has error", { exact: true }).click()
				await page.getByRole("button", { name: "Clear all" }).first().waitFor()
				await firstRowSettled(page)
			},
		}),
		list("exclude-service", "the only root service excluded (filtered empty)", {
			steps: async (page) => {
				await page.getByText("storefront", { exact: true }).first().hover()
				await page.getByRole("button", { name: "Exclude storefront" }).click()
				await page.getByText("No traces match these filters").first().waitFor()
			},
		}),
		list("sort-duration", "sorted by duration", {
			steps: async (page) => {
				await tracesTable(page).getByRole("button", { name: "Duration" }).click()
				await tracesTable(page)
					.getByRole("columnheader", { name: "Duration" })
					.and(page.locator("[aria-sort]"))
					.waitFor()
				await firstRowSettled(page)
			},
		}),
		list("time-range", "last 1 hour from the time range picker", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Last 12 hours" }).click()
				await page.getByRole("dialog").getByRole("button", { name: "Last 1 hour" }).click()
				await page.getByRole("dialog").waitFor({ state: "detached" })
				await firstRowSettled(page)
			},
		}),
		list("duration-preset", "the > 1s duration preset", {
			steps: async (page) => {
				await page.getByRole("button", { name: "> 1s" }).click()
				await page.getByRole("button", { name: "Clear", exact: true }).waitFor()
			},
		}),
	],
}
