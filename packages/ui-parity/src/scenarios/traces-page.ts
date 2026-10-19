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

/** `/traces/$traceId` states on dataset `default`: the pool-timeout trace, held, failing, unknown. */
const POOL_TIMEOUT_TRACE = "6843a8853182b32339b2dd5120d423f2"
const detail = (id: string, title: string, options: Partial<Scenario> = {}): Scenario => ({
	id: `traces-detail-${id}`,
	title: `Trace detail: ${title}`,
	path: `/traces/${POOL_TIMEOUT_TRACE}`,
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "traces",
	...options,
})

export const traceDetailStatesArea: AreaModule = {
	area: "traces",
	scenarios: [
		detail("loading", "loading (span hierarchy held)", {
			faults: { delays: { "queryEngine.spanHierarchy": HELD_MS } },
			settle: "held",
		}),
		detail("error", "span hierarchy failing", {
			faults: {
				failures: {
					"queryEngine.spanHierarchy": {
						status: 502,
						body: {
							_tag: "@maple/http/errors/QueryEngineExecutionError",
							message: "ui-parity: injected span hierarchy failure",
						},
					},
				},
			},
			settle: "quiet",
		}),
		detail("unknown", "a well-formed id with no spans", {
			path: "/traces/00000000000000000000000000000001",
		}),
	],
}

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
		list("peek", "a plain row click peeks the trace", {
			steps: async (page) => {
				await firstRowSettled(page)
				await tracesTable(page).getByRole("row").nth(1).getByRole("cell").nth(1).click()
				await page.getByRole("dialog").getByText("Open trace").waitFor()
				await page.getByRole("dialog").getByText("Spans and timing", { exact: false }).waitFor()
				await page.mouse.move(2, 2)
			},
		}),
		list("peek-step", "the peek steps to the next trace", {
			steps: async (page) => {
				await firstRowSettled(page)
				await tracesTable(page).getByRole("row").nth(1).getByRole("cell").nth(1).click()
				await page.getByRole("dialog").getByText("Open trace").waitFor()
				await page.getByRole("button", { name: "Next trace" }).click()
				await page.getByRole("dialog").getByText(/^2 of/).waitFor()
				await page.mouse.move(2, 2)
			},
		}),
		list("peek-open", "Open trace from the peek", {
			steps: async (page) => {
				await firstRowSettled(page)
				await tracesTable(page).getByRole("row").nth(1).getByRole("cell").nth(1).click()
				await page.getByRole("dialog").getByText("Open trace").click()
				await page.waitForURL(/\/traces\/[0-9a-f]{32}/)
				await page.getByRole("tab", { name: "Waterfall" }).waitFor()
				await page.mouse.move(2, 2)
			},
		}),
		list("peek-url", "a peek from the URL", {
			path: "/traces?peek=6843a8853182b32339b2dd5120d423f2",
			steps: async (page) => {
				await page.getByRole("dialog").getByText("Open trace").waitFor()
				await page.getByRole("dialog").getByText("Spans and timing", { exact: false }).waitFor()
			},
		}),
		list("keyboard", "j, j focuses the second row", {
			steps: async (page) => {
				await firstRowSettled(page)
				await page.keyboard.press("j")
				await page.keyboard.press("j")
				await tracesTable(page).locator("[data-focused]").waitFor()
			},
		}),
		list("keyboard-enter", "j then Enter peeks the row", {
			steps: async (page) => {
				await firstRowSettled(page)
				await page.keyboard.press("j")
				await page.keyboard.press("Enter")
				await page.getByRole("dialog").getByText("Open trace").waitFor()
				await page.getByRole("dialog").getByText("Spans and timing", { exact: false }).waitFor()
			},
		}),
		list("advanced-filter", "the advanced filter dialog", {
			steps: async (page) => {
				await firstRowSettled(page)
				await page.getByRole("button", { name: /Advanced filter/ }).click()
				await page.getByRole("dialog").getByText("Apply filter").waitFor()
				await page.mouse.move(2, 2)
			},
		}),
		list("advanced-filter-apply", "a where clause applied", {
			steps: async (page) => {
				await firstRowSettled(page)
				await page.getByRole("button", { name: /Advanced filter/ }).click()
				await page
					.getByRole("textbox", { name: "Advanced traces where clause" })
					.fill('service.name = "storefront"')
				await page.getByRole("button", { name: "Apply filter" }).click()
				await page.getByRole("button", { name: "Clear filter" }).first().waitFor()
				await firstRowSettled(page)
				await page.mouse.move(2, 2)
			},
		}),
		list("advanced-filter-typed", "a where clause typed, not applied", {
			steps: async (page) => {
				await firstRowSettled(page)
				await page.getByRole("button", { name: /Advanced filter/ }).click()
				await page
					.getByRole("textbox", { name: "Advanced traces where clause" })
					.fill('service.name = "storefront" AND foo')
				await page.getByRole("dialog").getByText("Apply filter").waitFor()
				await page.mouse.move(2, 2)
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
