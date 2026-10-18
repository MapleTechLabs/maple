import type { Page } from "playwright"
import { clickButton, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/**
 * Dashboards built from the API's templates: stat, table, chart and list widgets, the builder in
 * edit mode, one widget's editor, and the template gallery.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const platform = `/dashboards/${SEEDED.platformDashboard}`

const clickMenuItem = (name: string | RegExp) => (page: Page) =>
	page.getByRole("menuitem", { name }).first().click()
const clickMenuRadio = (name: string | RegExp) => (page: Page) =>
	page.getByRole("menuitemradio", { name }).first().click()

/** A row's kebab menu on the list. */
const rowMenu = (dashboardName: string) => clickButton(`More actions for ${dashboardName}`)

/** Typing into the toolbar search, then the 300 ms debounce that writes `?q=`. */
const searchList = (query: string) => async (page: Page) => {
	await page.getByRole("textbox", { name: "Search dashboards" }).fill(query)
	await page.waitForTimeout(400)
}

/** A portable dashboard file, as Export writes it. */
const PORTABLE_DASHBOARD = JSON.stringify({
	name: "Imported checkout board",
	description: "Checkout latency, from a file.",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
})

const importFile = async (page: Page) => {
	await page.getByLabel("Import dashboard JSON file").setInputFiles({
		name: "checkout.json",
		mimeType: "application/json",
		buffer: Buffer.from(PORTABLE_DASHBOARD),
	})
	await page.waitForTimeout(300)
}

const typeTag = (tag: string) => async (page: Page) => {
	await page.getByRole("textbox", { name: "Add a tag" }).fill(tag)
	await page.keyboard.press("Enter")
}

export const dashboardsArea: AreaModule = {
	area: "dashboards",
	scenarios: [
		dashboard("list", "List with template-built boards", "/dashboards"),
		dashboard("list-sort-menu", "List: sort menu open", "/dashboards", {
			steps: act(clickButton("Recently updated")),
		}),
		dashboard("list-sorted", "List: sorted by name", "/dashboards", {
			steps: act(clickButton("Recently updated"), clickMenuRadio("Name A–Z")),
		}),
		dashboard("list-search", "List: searched for payment", "/dashboards", {
			steps: act(searchList("payment")),
		}),
		dashboard("list-search-none", "List: a search nothing matches", "/dashboards", {
			steps: act(searchList("zzz-nothing")),
		}),
		dashboard("list-starred", "List: Platform overview starred", "/dashboards", {
			steps: act(clickButton("Star Platform overview")),
		}),
		dashboard("list-favorites-scope", "List: Favorites scope with nothing starred", "/dashboards", {
			steps: act(clickButton("Favorites")),
		}),
		dashboard("list-row-menu", "List: a row's actions menu", "/dashboards", {
			steps: act(rowMenu("Platform overview")),
		}),
		dashboard("list-delete-confirm", "List: delete confirmation", "/dashboards", {
			steps: act(rowMenu("Platform overview"), clickMenuItem("Delete…")),
		}),
		// Legacy's optimistic delete is racy against the fixture's live shape poll (the row is gone
		// in some captures and back in others), so the page body is masked: the call log is the check.
		dashboard("list-deleted", "List: Platform overview deleted", "/dashboards", {
			steps: act(
				rowMenu("Platform overview"),
				clickMenuItem("Delete…"),
				clickButton("Delete for everyone"),
			),
			mask: (page) => [page.getByRole("main")],
		}),
		dashboard("list-duplicate", "List: Platform overview duplicated", "/dashboards", {
			steps: act(rowMenu("Platform overview"), clickMenuItem("Duplicate")),
		}),
		dashboard("list-tags-dialog", "List: tag editor with a typed tag", "/dashboards", {
			steps: act(rowMenu("Platform overview"), clickMenuItem("Edit tags…"), typeTag("slo")),
		}),
		dashboard("list-tags-saved", "List: tags saved", "/dashboards", {
			steps: act(
				rowMenu("Platform overview"),
				clickMenuItem("Edit tags…"),
				typeTag("slo"),
				clickButton("Save"),
			),
		}),
		dashboard("list-create", "List: Create dashboard", "/dashboards", {
			steps: act(clickButton("Create dashboard")),
		}),
		dashboard("list-import", "List: a portable dashboard imported", "/dashboards", {
			steps: act(importFile),
		}),
		dashboard("platform", "Platform overview (stat, table, chart, list)", platform, { fullPage: true }),
		dashboard("payment", "Payment service health", `/dashboards/${SEEDED.paymentDashboard}`),
		dashboard("edit", "Platform overview in edit mode", platform, {
			steps: act(clickButton("Edit dashboard")),
		}),
		dashboard("widget", "Throughput chart widget editor", `${platform}/widgets/throughput-by-service`),
		dashboard("templates", "Template gallery", "/dashboards/templates"),
		dashboard("template-preview", "Service Health template preview", "/dashboards/templates", {
			steps: act(clickButton(/^Service Health/)),
		}),
		dashboard("list-empty", "Dashboards (empty org)", "/dashboards", { dataset: EMPTY }),
		dashboard("list-empty-create", "Dashboards (empty org): Create blank dashboard", "/dashboards", {
			dataset: EMPTY,
			steps: act(clickButton("Create blank dashboard")),
		}),
	],
}
